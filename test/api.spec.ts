import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createHttpApplication } from '../src/bootstrap/application';
import { readConfig } from '../src/bootstrap/config';
import { testDatabase, resetDatabase, seedIdentity } from './support';

const uid = '04AABBCCDDEE01';
type Provisioned = { orderId: string; id: string; referenciaNdef: string | null };

describe('HTTP API with PostgreSQL', () => {
  let source: DataSource;
  let app: INestApplication;
  let token: string;
  const http = () => ({
    get: (path: string) => request(app.getHttpServer()).get(path).auth(token, { type: 'bearer' }),
    post: (path: string) => request(app.getHttpServer()).post(path).auth(token, { type: 'bearer' }),
  });

  beforeAll(async () => {
    source = await testDatabase();
    const config = readConfig({
      DATABASE_URL: 'postgresql://unused@localhost/test',
      APP_PROCESS_ROLE: 'api',
    });
    app = await createHttpApplication(config, source, false, true);
  });
  afterAll(async () => {
    await app?.close();
    if (source?.isInitialized) await source.destroy();
  });
  beforeEach(async () => {
    await resetDatabase(source);
    token = (await seedIdentity(source)).token;
  });

  async function order(code = `LAB-${randomUUID()}`): Promise<string> {
    const response = await http().post('/api/v1/pedidos').send({ codigo: code }).expect(201);
    return response.body.dados.id as string;
  }
  async function provision(strategy = 'UID', active = true): Promise<Provisioned> {
    const orderId = await order();
    const response = await http()
      .post('/api/v1/etiquetas')
      .send({ pedidoId: orderId, uid, modelo: 'NTAG424DNA', estrategia: strategy })
      .expect(201);
    const data = response.body.dados as { id: string; referenciaNdef: string | null };
    if (active)
      await http()
        .post(`/api/v1/provisionamentos/${data.id}/ativacao`)
        .send({
          bloqueioConfirmado: true,
          ...(data.referenciaNdef ? { referenciaNdef: data.referenciaNdef } : {}),
        })
        .expect(200);
    return { orderId, ...data };
  }
  function capture(p: Provisioned, type = 'COLETA') {
    return {
      id: randomUUID(),
      versaoContrato: 1,
      provisionamentoId: p.id,
      tipo: type,
      ocorridoEm: '2026-09-24T12:00:00.000Z',
      dispositivoId: 'android-lab-01',
      leituraBruta: { uid, ...(p.referenciaNdef ? { ndef: p.referenciaNdef } : {}) },
    };
  }

  it('serves readiness, metrics and the OpenAPI contract', async () => {
    await http().get('/health/live').expect(200, { status: 'ok' });
    await http().get('/health/ready').expect(200, { status: 'ready' });
    const metrics = await http().get('/metrics').expect(200);
    expect(metrics.text).toContain('nfc_outbox_events{status="FAILED"} 0');
    const spec = await http().get('/openapi.json').expect(200);
    expect(spec.body.paths['/api/v1/eventos'].post.responses['200']).toBeDefined();
    expect(spec.body.components.schemas.ObservationDto.required).toContain('leituraBruta');
  });
  it('creates normalized codes, rejects duplicates, searches and paginates', async () => {
    const id = await order(' tcc-001 ');
    const duplicate = await http().post('/api/v1/pedidos').send({ codigo: 'TCC-001' }).expect(409);
    expect(duplicate.body.codigo).toBe('CODIGO_PEDIDO_DUPLICADO');
    const page = await http().get('/api/v1/pedidos?busca=tcc&limite=1').expect(200);
    expect(page.body.dados).toMatchObject({
      total: 1,
      pagina: 1,
      limite: 1,
      itens: [{ id, codigo: 'TCC-001' }],
    });
    await http().get('/api/v1/pedidos?limite=101').expect(400);
    await http().get(`/api/v1/pedidos/${randomUUID()}`).expect(404);
  });
  it('rejects extra fields, null optionals, invalid identifiers and SDM', async () => {
    await http().post('/api/v1/pedidos').send({ codigo: 'X', admin: true }).expect(400);
    await http().post('/api/v1/pedidos').send({ codigo: 'X', descricao: null }).expect(400);
    await http().get('/api/v1/pedidos/not-a-uuid').expect(400);
    const orderId = await order();
    const dynamic = await http()
      .post('/api/v1/etiquetas')
      .send({ pedidoId: orderId, uid, modelo: 'NTAG424DNA', estrategia: 'DINAMICA' })
      .expect(422);
    expect(dynamic.body.codigo).toBe('ESTRATEGIA_INDISPONIVEL');
  });
  it('reports malformed and oversized JSON with stable errors', async () => {
    const malformed = await http()
      .post('/api/v1/pedidos')
      .set('Content-Type', 'application/json')
      .send('{')
      .expect(400);
    expect(malformed.body.codigo).toBe('ENTRADA_INVALIDA');
    const large = await http()
      .post('/api/v1/pedidos')
      .send({ codigo: 'X', descricao: 'x'.repeat(33000) })
      .expect(413);
    expect(large.body.codigo).toBe('PAYLOAD_EXCEDIDO');
  });
  it('keeps physical configuration pending and activates exactly once under concurrency', async () => {
    const p = await provision('NDEF_ESTATICO', false);
    await http()
      .post(`/api/v1/provisionamentos/${p.id}/ativacao`)
      .send({ bloqueioConfirmado: false })
      .expect(400);
    const inactive = await http().post('/api/v1/eventos').send(capture(p)).expect(200);
    expect(inactive.body.dados.decisao).toMatchObject({
      autorizada: false,
      motivo: 'VINCULO_INATIVO',
    });
    await Promise.all(
      Array.from({ length: 4 }, () =>
        http()
          .post(`/api/v1/provisionamentos/${p.id}/ativacao`)
          .send({ bloqueioConfirmado: true, referenciaNdef: p.referenciaNdef })
          .expect(200),
      ),
    );
    const rows = await source.query("SELECT * FROM movements WHERE type='PROVISIONAMENTO'");
    expect(rows).toHaveLength(1);
    const byUid = await http().get(`/api/v1/etiquetas/${uid}`).expect(200);
    expect(byUid.body.dados.status).toBe('ATIVA');
  });
  it('runs all operational events and preserves rejected attempts', async () => {
    const p = await provision();
    for (const type of ['COLETA', 'MOVIMENTACAO', 'RECEBIMENTO', 'MOVIMENTACAO', 'EXPEDICAO']) {
      const result = await http().post('/api/v1/eventos').send(capture(p, type)).expect(200);
      expect(result.body.dados.decisao.autorizada).toBe(true);
    }
    const repeatedDispatch = await http()
      .post('/api/v1/eventos')
      .send(capture(p, 'EXPEDICAO'))
      .expect(200);
    expect(repeatedDispatch.body.dados.decisao).toMatchObject({
      autorizada: false,
      motivo: 'SEQUENCIA_INVALIDA',
    });
    await http().post('/api/v1/eventos').send(capture(p, 'ENTREGA')).expect(200);
    const old = await http().post('/api/v1/eventos').send(capture(p, 'COLETA')).expect(200);
    expect(old.body.dados.decisao).toMatchObject({
      autorizada: false,
      estadoResultante: 'ENTREGUE',
    });
    const history = await http().get(`/api/v1/pedidos/${p.orderId}/eventos`).expect(200);
    expect(history.body.dados.total).toBe(9);
    expect(history.body.dados.itens[0].tipo).toBe('PROVISIONAMENTO');
    expect(
      history.body.dados.itens.filter(
        (item: { decisao: { autorizada: boolean } }) => !item.decisao.autorizada,
      ),
    ).toHaveLength(2);
  });
  it('returns the same durable result after lost response, including concurrent requests', async () => {
    const p = await provision();
    const input = capture(p);
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => http().post('/api/v1/eventos').send(input).expect(200)),
    );
    for (const result of responses) expect(result.body).toEqual(responses[0]!.body);
    expect(await source.query('SELECT * FROM observations')).toHaveLength(1);
    expect(await source.query("SELECT * FROM movements WHERE type='COLETA'")).toHaveLength(1);
    const get = await http().get(`/api/v1/eventos/${input.id}`).expect(200);
    expect(get.body).toEqual(responses[0]!.body);
    const conflict = await http()
      .post('/api/v1/eventos')
      .send({ ...input, tipo: 'ENTREGA' })
      .expect(409);
    expect(conflict.body.codigo).toBe('IDEMPOTENCIA_CONFLITO');
  });
  it('serializes competing captures on the same order', async () => {
    const p = await provision();
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => http().post('/api/v1/eventos').send(capture(p)).expect(200)),
    );
    expect(responses.filter((result) => result.body.dados.decisao.autorizada)).toHaveLength(1);
    expect(await source.query('SELECT * FROM observations')).toHaveLength(5);
    expect(await source.query("SELECT * FROM movements WHERE type='COLETA'")).toHaveLength(1);
  });
  it('arbitrates concurrent associations of the same tag to different orders', async () => {
    const orders = await Promise.all([order(), order()]);
    const results = await Promise.all(
      orders.map((pedidoId) =>
        http()
          .post('/api/v1/etiquetas')
          .send({ pedidoId, uid, modelo: 'NTAG424DNA', estrategia: 'UID' }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await source.query('SELECT * FROM tags')).toHaveLength(1);
    expect(await source.query('SELECT * FROM provisionings')).toHaveLength(1);
  });
  it('arbitrates different tags competing for the same order', async () => {
    const pedidoId = await order();
    const results = await Promise.all(
      [uid, '04AABBCCDDEE02'].map((tagUid) =>
        http()
          .post('/api/v1/etiquetas')
          .send({ pedidoId, uid: tagUid, modelo: 'NTAG424DNA', estrategia: 'UID' }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  });
  it('accepts a copied static NDEF as suspicious, but rejects incorrect NDEF with matching UID', async () => {
    const p = await provision('NDEF_ESTATICO');
    const wrong = capture(p);
    wrong.leituraBruta.ndef = 'urn:wrong';
    const rejected = await http().post('/api/v1/eventos').send(wrong).expect(200);
    expect(rejected.body.dados.decisao).toMatchObject({
      autorizada: false,
      motivo: 'NDEF_DIVERGENTE',
    });
    const copied = capture(p);
    copied.leituraBruta.uid = '04AABBCCDDEE02';
    const accepted = await http().post('/api/v1/eventos').send(copied).expect(200);
    expect(accepted.body.dados.decisao).toMatchObject({
      autorizada: true,
      classificacao: 'SUSPEITO',
      avisos: ['UID_DIVERGENTE'],
    });
  });
  it('preserves unknown bindings and reserved-event attempts without effects', async () => {
    const p = await provision();
    const reserved = await http()
      .post('/api/v1/eventos')
      .send(capture(p, 'PROVISIONAMENTO'))
      .expect(200);
    expect(reserved.body.dados.decisao.motivo).toBe('EVENTO_RESERVADO');
    const input = { ...capture(p), provisionamentoId: randomUUID() };
    const unknown = await http().post('/api/v1/eventos').send(input).expect(200);
    expect(unknown.body.dados).toMatchObject({
      pedidoId: null,
      decisao: { autorizada: false, motivo: 'VINCULO_NAO_ENCONTRADO' },
    });
    await http().get(`/api/v1/eventos/${input.id}`).expect(200);
  });
  it('closes bindings idempotently, reuses the tag in a new epoch and preserves history', async () => {
    const p = await provision();
    await http().post(`/api/v1/provisionamentos/${p.id}/encerramento`).expect(200);
    await http().post(`/api/v1/provisionamentos/${p.id}/encerramento`).expect(200);
    const another = await order();
    const next = await http()
      .post('/api/v1/etiquetas')
      .send({ pedidoId: another, uid, modelo: 'NTAG424DNA', estrategia: 'NDEF_ESTATICO' })
      .expect(201);
    expect(next.body.dados.epoca).toBe(2);
    const old = await http().post('/api/v1/eventos').send(capture(p)).expect(200);
    expect(old.body.dados.decisao.motivo).toBe('VINCULO_INATIVO');
    const previous = await http().get(`/api/v1/provisionamentos/${p.id}`).expect(200);
    expect(previous.body.dados).toMatchObject({
      status: 'DESPROVISIONADA',
      estrategia: 'UID',
      epoca: 1,
    });
    expect(
      (await http().get(`/api/v1/pedidos/${p.orderId}/eventos`).expect(200)).body.dados.total,
    ).toBe(2);
  });
  it('never overwrites historical evidence in SQL', async () => {
    const p = await provision();
    const input = capture(p);
    await http().post('/api/v1/eventos').send(input).expect(200);
    await expect(
      source.query('UPDATE observations SET input=$1 WHERE id=$2', [{ forged: true }, input.id]),
    ).rejects.toThrow('append-only');
    await expect(
      source.query("UPDATE provisionings SET strategy='NDEF_ESTATICO' WHERE id=$1", [p.id]),
    ).rejects.toThrow('immutable');
  });
});
