import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createHttpApplication } from '../src/bootstrap/application';
import { readConfig } from '../src/bootstrap/config';
import { RecordObservation } from '../src/bounded-contexts/traceability/application/record-observation';
import { testDatabase, resetDatabase, seedIdentity } from './support';

describe('Durable synchronization batch / PostgreSQL', () => {
  let source: DataSource;
  let app: INestApplication;
  let token: string;
  const post = (path: string, value: object, bearer = token) =>
    request(app.getHttpServer())
      .post('/api/v1' + path)
      .auth(bearer, { type: 'bearer' })
      .send(value);
  beforeAll(async () => {
    source = await testDatabase();
    app = await createHttpApplication(
      readConfig({ DATABASE_URL: 'postgresql://unused@localhost/test', APP_PROCESS_ROLE: 'api' }),
      source,
      false,
      true,
    );
  });
  afterAll(async () => {
    await app?.close();
    if (source?.isInitialized) await source.destroy();
  });
  beforeEach(async () => {
    await resetDatabase(source);
    token = (await seedIdentity(source)).token;
  });
  async function setup(strategy = 'UID') {
    const order = await post('/pedidos', { codigo: 'BATCH-' + randomUUID() }).expect(201);
    const tag = await post('/etiquetas', {
      pedidoId: order.body.dados.id,
      uid: '04AABBCCDDEE01',
      modelo: 'FIXTURE',
      estrategia: strategy,
    }).expect(201);
    const p = tag.body.dados as { id: string; referenciaNdef: string | null };
    await post('/provisionamentos/' + p.id + '/ativacao', {
      bloqueioConfirmado: true,
      ...(p.referenciaNdef ? { referenciaNdef: p.referenciaNdef } : {}),
    }).expect(200);
    const capture = (tipo = 'COLETA') => ({
      id: randomUUID(),
      versaoContrato: 1,
      provisionamentoId: p.id,
      tipo,
      ocorridoEm: '2026-10-06T13:00:00.000Z',
      dispositivoId: 'fixture-android',
      leituraBruta: {
        uid: '04AABBCCDDEE01',
        bytesBase64: '0QEDVQBh',
        ...(p.referenciaNdef ? { ndef: p.referenciaNdef } : {}),
      },
    });
    return { capture, orderId: order.body.dados.id as string };
  }
  it.each(['UID', 'NDEF_ESTATICO'])(
    'preserves valid/rejected/conflicting/invalid items and retries original receipts (%s)',
    async (strategy) => {
      const { capture, orderId } = await setup(strategy);
      const first = capture();
      const original = await post('/eventos', first).expect(200);
      const delivery = capture('ENTREGA');
      const reception = capture('RECEBIMENTO');
      const entries = [
        first,
        { ...first, dispositivoId: 'changed' },
        null,
        { ...capture(), extra: true },
        delivery,
        reception,
      ];
      const batch = await post('/eventos/lote', { itens: entries }).expect(200);
      const items = batch.body.dados.itens;
      expect(items.map((item: { status: number }) => item.status)).toEqual([
        200, 409, 400, 400, 200, 200,
      ]);
      expect(items.map((item: { indice: number }) => item.indice)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(items[0].dados).toEqual(original.body.dados);
      expect(items[1].codigo).toBe('IDEMPOTENCIA_CONFLITO');
      expect(items[4].dados.decisao.autorizada).toBe(false);
      expect(items[5].dados.decisao.autorizada).toBe(true);
      const repeated = await post('/eventos/lote', { itens: [first, delivery, reception] }).expect(
        200,
      );
      expect(repeated.body.dados.itens.map((item: { dados: unknown }) => item.dados)).toEqual([
        items[0].dados,
        items[4].dados,
        items[5].dados,
      ]);
      expect(await source.query('SELECT * FROM observations')).toHaveLength(3);
      expect(
        await source.query('SELECT * FROM movements WHERE observation_id IS NOT NULL'),
      ).toHaveLength(2);
      const orders = (await source.query('SELECT state FROM orders WHERE id=$1', [orderId])) as {
        state: string;
      }[];
      expect(orders[0]?.state).toBe('RECEBIDO');
    },
  );
  it('contains a transient failure to one item and permits exact recovery', async () => {
    const { capture } = await setup();
    const failed = capture();
    const successful = capture();
    const command = app.get(RecordObservation);
    const spy = jest
      .spyOn(command, 'execute')
      .mockRejectedValueOnce(new Error('temporary database failure'));
    try {
      const result = await post('/eventos/lote', { itens: [failed, successful] }).expect(200);
      expect(result.body.dados.itens.map((item: { status: number }) => item.status)).toEqual([
        500, 200,
      ]);
      expect(await source.query('SELECT * FROM observations')).toHaveLength(1);
      const retry = await post('/eventos/lote', { itens: [failed, successful] }).expect(200);
      expect(retry.body.dados.itens[0].dados.armazenada).toBe(true);
      expect(retry.body.dados.itens[1].dados).toEqual(result.body.dados.itens[1].dados);
      expect(await source.query('SELECT * FROM observations')).toHaveLength(2);
    } finally {
      spy.mockRestore();
    }
  });
  it('uses authentication and maintains per-capture operator identity', async () => {
    const { capture } = await setup();
    const observation = capture();
    await post('/eventos/lote', { itens: [observation] }).expect(200);
    const other = await seedIdentity(source, 'OPERADOR');
    const result = await post('/eventos/lote', { itens: [observation] }, other.token).expect(200);
    expect(result.body.dados.itens[0]).toMatchObject({
      status: 409,
      codigo: 'IDEMPOTENCIA_OPERADOR_DIVERGENTE',
    });
    const viewer = await seedIdentity(source, 'CONSULTA');
    await post('/eventos/lote', { itens: [capture()] }, viewer.token).expect(403);
    await request(app.getHttpServer())
      .post('/api/v1/eventos/lote')
      .send({ itens: [capture()] })
      .expect(401);
    expect(await source.query('SELECT * FROM observations')).toHaveLength(1);
  });
  it('limits the envelope size/count and documents per-item results', async () => {
    await post('/eventos/lote', { itens: [] }).expect(400);
    await post('/eventos/lote', { itens: Array(51).fill(null) }).expect(400);
    await post('/eventos/lote', { itens: [null], unexpected: true }).expect(400);
    await post('/eventos/lote', { itens: [{ data: 'a'.repeat(33000) }] }).expect(413);
    const spec = await request(app.getHttpServer()).get('/openapi.json').expect(200);
    expect(spec.body.paths['/api/v1/eventos/lote'].post.responses['200']).toBeDefined();
    expect(spec.body.components.schemas.ObservationBatchDto.properties.itens.maxItems).toBe(50);
  });
  it('concurrent retransmissions share the individual transaction/idempotency protection', async () => {
    const { capture } = await setup();
    const original = capture();
    const [a, b] = await Promise.all([
      post('/eventos/lote', { itens: [original] }),
      post('/eventos/lote', { itens: [original] }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.dados.itens[0].dados).toEqual(b.body.dados.itens[0].dados);
    expect(await source.query('SELECT * FROM observations')).toHaveLength(1);
    expect(
      await source.query('SELECT * FROM movements WHERE observation_id IS NOT NULL'),
    ).toHaveLength(1);
  });
});
