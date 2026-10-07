import { randomBytes, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createHttpApplication } from '../src/bootstrap/application';
import { readConfig } from '../src/bootstrap/config';
import { ReconcileObservations } from '../src/bounded-contexts/traceability/application/reconcile-observations';
import { ReconciliationConsumer } from '../src/platform/messaging/reconciliation-consumer';
import { OutboxDispatcher } from '../src/platform/messaging/outbox-dispatcher';
import { AuditConsumer } from '../src/platform/audit/audit-consumer';
import { NodeIds, SystemClock } from '../src/platform/runtime';
import { NodeSdmCryptography } from '../src/bounded-contexts/traceability/infrastructure/sdm-crypto';
import { SdmConfiguration } from '../src/bounded-contexts/traceability/domain/sdm';
import { Reading } from '../src/bounded-contexts/traceability/domain/types';
import { SealedSdmKeys } from '../src/bounded-contexts/traceability/application/sdm-ports';
import { Clock } from '../src/bounded-contexts/traceability/application/ports';
import { Reconciliation1790000003000 } from '../src/platform/database/migrations/1790000003000-reconciliation';
import { resetDatabase, seedIdentity, testDatabase } from './support';
import { syntheticSdmReading } from './sdm-fixtures';

const uid = '04AABBCCDDEE01';
describe('Durable reconciliation / real PostgreSQL / synthetic SDM, no hardware acceptance', () => {
  let db: DataSource;
  let app: INestApplication;
  let user: Awaited<ReturnType<typeof seedIdentity>>;
  let token: string;
  const masters = JSON.stringify({ '1': randomBytes(32).toString('base64') });
  const vault = new NodeSdmCryptography('1', masters);
  const http = () => ({
    get: (path: string) => request(app.getHttpServer()).get(path).auth(token, { type: 'bearer' }),
    post: (path: string) => request(app.getHttpServer()).post(path).auth(token, { type: 'bearer' }),
  });
  beforeAll(async () => {
    db = await testDatabase();
    app = await createHttpApplication(
      readConfig({
        DATABASE_URL: 'postgresql://unused@localhost/test',
        APP_PROCESS_ROLE: 'api',
        SDM_ACTIVE_MASTER_VERSION: '1',
        SDM_MASTER_KEYS_JSON: masters,
      }),
      db,
      false,
      true,
    );
  });
  afterAll(async () => {
    await app?.close();
    if (db?.isInitialized) await db.destroy();
  });
  beforeEach(async () => {
    await resetDatabase(db);
    user = await seedIdentity(db);
    token = user.token;
  });
  function worker(clock: Clock = new SystemClock(), fail = false) {
    return new OutboxDispatcher(
      db,
      [
        new AuditConsumer(),
        new ReconciliationConsumer(new ReconcileObservations(clock, new NodeIds())),
        ...(fail
          ? [
              {
                id: 'test.fail',
                handle: async () => {
                  throw new Error('after reconciliation');
                },
              },
            ]
          : []),
      ],
      { batchSize: 100, leaseMs: 30000 },
    );
  }
  async function drain(w = worker()) {
    for (let i = 0; i < 12; i++) if (!(await w.tick())) return;
    throw new Error('Unexpected outbox loop');
  }
  async function link(strategy = 'UID', policy = 'ESTRITA') {
    const orderId = (
      await http()
        .post('/api/v1/pedidos')
        .send({ codigo: `REC-${randomUUID()}` })
        .expect(201)
    ).body.dados.id as string;
    const p = (
      await http()
        .post('/api/v1/etiquetas')
        .send({
          pedidoId: orderId,
          uid,
          modelo: 'SYNTHETIC-TEST',
          estrategia: strategy,
          ...(strategy === 'SDM' ? { politicaSdm: policy } : {}),
        })
        .expect(201)
    ).body.dados;
    const sdm =
      strategy === 'SDM'
        ? ((await db.query('SELECT sdm FROM provisionings WHERE id=$1', [p.id]))[0]
            .sdm as SdmConfiguration)
        : null;
    const sealed =
      strategy === 'SDM'
        ? ((await db.query('SELECT sealed FROM sdm_keys WHERE provisioning_id=$1', [p.id]))[0]
            .sealed as SealedSdmKeys)
        : null;
    const reading = (counter: number): Reading =>
      sdm && sealed
        ? syntheticSdmReading(vault, p.id, sdm, sealed, uid, counter)
        : { uid, ...(p.referenciaNdef ? { ndef: p.referenciaNdef } : {}) };
    await http()
      .post(`/api/v1/provisionamentos/${p.id}/ativacao`)
      .send({
        bloqueioConfirmado: true,
        ...(strategy === 'SDM'
          ? { leituraSdm: reading(1) }
          : { referenciaNdef: p.referenciaNdef ?? undefined }),
      })
      .expect(200);
    let counter = 1;
    const capture = (tipo: string) => ({
      id: randomUUID(),
      versaoContrato: 1,
      provisionamentoId: p.id,
      tipo,
      ocorridoEm: '2000-01-01T12:00:00.000Z',
      dispositivoId: 'synthetic-reconciliation',
      leituraBruta: reading(++counter),
    });
    return { id: p.id, orderId, capture, reading };
  }
  const save = async (input: object) =>
    (await http().post('/api/v1/eventos').send(input).expect(200)).body.dados;
  const query = async (id: string) =>
    (
      await http()
        .get('/api/v1/eventos/' + id)
        .expect(200)
    ).body.dados;
  const state = async (id: string) =>
    (
      await http()
        .get('/api/v1/pedidos/' + id)
        .expect(200)
    ).body.dados;

  it.each([
    ['UID', 'ESTRITA'],
    ['NDEF_ESTATICO', 'ESTRITA'],
    ['SDM', 'ESTRITA'],
    ['SDM', 'REGISTRO_TARDIO'],
  ])(
    'reconciles six steps, retains receipt and never consumes SDM again (%s/%s)',
    async (strategy, policy) => {
      const p = await link(strategy, policy);
      const delivery = p.capture('ENTREGA');
      const receipt = await save(delivery);
      expect(receipt.decisao).toMatchObject({
        status: 'PENDENTE',
        revisao: 1,
        autorizada: false,
        motivo: 'AGUARDANDO_ANTECEDENTE',
        dependencias: [
          { tipo: 'COLETA', estadoNecessario: 'COLETADO' },
          { tipo: 'RECEBIMENTO', estadoNecessario: 'RECEBIDO' },
        ],
      });
      const inputs = ['RECEBIMENTO', 'MOVIMENTACAO', 'EXPEDICAO'].map(p.capture);
      for (const input of inputs) expect((await save(input)).decisao.status).toBe('PENDENTE');
      await drain();
      expect((await query(delivery.id)).decisao.revisao).toBe(1);
      await save(p.capture('COLETA'));
      await drain();
      expect(await state(p.orderId)).toMatchObject({
        estado: 'ENTREGUE',
        expedido: true,
        versao: 5,
      });
      const current = await query(delivery.id);
      expect(current.decisao).toMatchObject({
        status: 'AUTORIZADA',
        autorizada: true,
        estadoAnterior: 'RECEBIDO',
        estadoResultante: 'ENTREGUE',
      });
      expect(current.historicoDecisoes[0]).toEqual(receipt.decisao);
      expect(current.historicoDecisoes.length).toBeGreaterThanOrEqual(2);
      expect(current.recebidoEm).toEqual(receipt.recebidoEm);
      expect(current.leituraBruta).toEqual(receipt.leituraBruta);
      expect(await save(delivery)).toEqual(receipt);
      await http()
        .post('/api/v1/eventos')
        .send({ ...delivery, tipo: 'MOVIMENTACAO' })
        .expect(409);
      expect(
        await db.query('SELECT * FROM movements WHERE observation_id=$1', [delivery.id]),
      ).toHaveLength(1);
      if (strategy === 'SDM') {
        expect(current.decisao.sdm).toEqual(receipt.decisao.sdm);
        expect((await db.query('SELECT maximum FROM sdm_counter_state'))[0].maximum).toBe(6);
        expect(await db.query('SELECT * FROM sdm_evidence')).toHaveLength(6);
        expect((await save({ ...delivery, id: randomUUID() })).decisao).toMatchObject({
          status: 'REJEITADA',
          motivo: 'SDM_EVIDENCIA_REUTILIZADA',
        });
      }
      const history = (await http().get(`/api/v1/pedidos/${p.orderId}/eventos`).expect(200)).body
        .dados.itens;
      expect(history[0].tipo).toBe('PROVISIONAMENTO');
      expect(history[1].id).toBe(delivery.id);
      expect(history[1].historicoDecisoes).toEqual(current.historicoDecisoes);
      const backwards = await save(p.capture('COLETA'));
      expect(backwards.decisao).toMatchObject({
        status: 'REJEITADA',
        motivo: 'PEDIDO_JA_ENTREGUE',
        estadoResultante: 'ENTREGUE',
      });
    },
  );
  it('partially satisfies concrete dependencies without adding revisions on repeated triggers', async () => {
    const p = await link();
    const input = p.capture('ENTREGA');
    await save(input);
    await save(p.capture('COLETA'));
    await drain();
    const partial = await query(input.id);
    expect(partial.decisao).toMatchObject({
      status: 'PENDENTE',
      revisao: 2,
      dependencias: [{ tipo: 'RECEBIMENTO', estadoNecessario: 'RECEBIDO' }],
    });
    await save(p.capture('MOVIMENTACAO'));
    await drain();
    expect((await query(input.id)).decisao).toEqual(partial.decisao);
    await save(p.capture('RECEBIMENTO'));
    await drain();
    expect((await query(input.id)).decisao).toMatchObject({ status: 'AUTORIZADA', revisao: 3 });
  });
  it('invalid UID/NDEF and forbidden roles cannot become deferred authorized work', async () => {
    const p = await link('NDEF_ESTATICO');
    const input = p.capture('RECEBIMENTO');
    expect(
      (await save({ ...input, leituraBruta: { uid, ndef: 'urn:invalid' } })).decisao,
    ).toMatchObject({ status: 'REJEITADA', evidencia: 'INVALIDA' });
    token = (await seedIdentity(db, 'CONSULTA')).token;
    await http().post('/api/v1/eventos').send(p.capture('RECEBIMENTO')).expect(403);
    expect(await db.query("SELECT * FROM current_decisions WHERE status='PENDENTE'")).toHaveLength(
      0,
    );
    token = user.token;
    await save(p.capture('COLETA'));
    await drain();
    expect((await query(input.id)).decisao.status).toBe('REJEITADA');
  });
  it('retains a copied static NDEF warning while allowing its pending logistics', async () => {
    const p = await link('NDEF_ESTATICO');
    const input = p.capture('RECEBIMENTO');
    input.leituraBruta.uid = '04FFFFFFFFFFFF';
    expect((await save(input)).decisao).toMatchObject({
      status: 'PENDENTE',
      classificacao: 'SUSPEITO',
      avisos: ['UID_DIVERGENTE'],
    });
    await save(p.capture('COLETA'));
    await drain();
    expect((await query(input.id)).decisao).toMatchObject({
      status: 'AUTORIZADA',
      classificacao: 'SUSPEITO',
      avisos: ['UID_DIVERGENTE'],
    });
  });
  it.each(['ESTRITA', 'REGISTRO_TARDIO'])(
    'never promotes late SDM on prerequisite arrival (%s)',
    async (policy) => {
      const p = await link('SDM', policy);
      const pending = p.capture('RECEBIMENTO');
      await save(pending);
      const late = { ...p.capture('RECEBIMENTO'), leituraBruta: p.reading(0) };
      expect((await save(late)).decisao.status).toBe('TARDIA');
      await save(p.capture('COLETA'));
      await drain();
      expect((await query(pending.id)).decisao.status).toBe('AUTORIZADA');
      expect((await query(late.id)).decisao).toMatchObject({
        status: 'TARDIA',
        revisao: 1,
        autorizada: false,
      });
      expect(
        await db.query('SELECT * FROM movements WHERE observation_id=$1', [late.id]),
      ).toHaveLength(0);
    },
  );
  it('closure permanently rejects the old epoch even after UID reuse', async () => {
    const p = await link();
    const input = p.capture('RECEBIMENTO');
    const receipt = await save(input);
    await http().post(`/api/v1/provisionamentos/${p.id}/encerramento`).expect(200);
    const next = await link();
    await save(next.capture('COLETA'));
    await drain();
    expect((await query(input.id)).decisao).toMatchObject({
      status: 'REJEITADA',
      motivo: 'VINCULO_ENCERRADO',
    });
    expect(await save(input)).toEqual(receipt);
    expect(await state(p.orderId)).toMatchObject({ estado: 'CADASTRADO' });
  });
  it.each(['revogacao', 'desativacao', 'logout'])(
    'identity changes produce a durable final rejection (%s)',
    async (action) => {
      const p = await link();
      const input = p.capture('RECEBIMENTO');
      await save(input);
      const observer = await seedIdentity(db);
      token = observer.token;
      if (action === 'logout')
        await request(app.getHttpServer())
          .post('/api/v1/autenticacao/logout')
          .auth(user.token, { type: 'bearer' })
          .expect(200);
      else await http().post(`/api/v1/usuarios/${user.id}/${action}`).expect(200);
      await drain();
      expect((await query(input.id)).decisao).toMatchObject({
        status: 'REJEITADA',
        motivo: 'PERMISSAO_REVOGADA',
      });
      await save(p.capture('COLETA'));
      await drain();
      expect(await state(p.orderId)).toMatchObject({ estado: 'COLETADO' });
      expect(
        await db.query('SELECT * FROM movements WHERE observation_id=$1', [input.id]),
      ).toHaveLength(0);
    },
  );
  it.each([1, 48])(
    'scheduled outbox survives restart and expires at the earlier session/24h limit (%ih session)',
    async (hours) => {
      await db.query(
        "UPDATE identity_sessions SET expires_at=clock_timestamp()+($2*interval '1 hour') WHERE id=$1",
        [user.sessionId, hours],
      );
      const p = await link();
      const input = p.capture('RECEBIMENTO');
      const receipt = await save(input);
      const expires = Date.parse(receipt.decisao.expiraEm);
      expect(expires - Date.parse(receipt.recebidoEm)).toBeLessThanOrEqual(
        Math.min(hours, 24) * 3600000,
      );
      await drain();
      const scheduled = (
        await db.query("SELECT * FROM outbox WHERE envelope->>'type'='ReconciliacaoPrazo'")
      )[0];
      expect(scheduled.status).toBe('PENDING');
      expect(scheduled.available_at.toISOString()).toBe(receipt.decisao.expiraEm);
      await db.query('UPDATE outbox SET available_at=clock_timestamp() WHERE id=$1', [
        scheduled.id,
      ]);
      await drain(worker({ now: () => new Date(expires + 1).toISOString() }));
      expect((await query(input.id)).decisao).toMatchObject({
        status: 'REJEITADA',
        motivo: hours === 1 ? 'SESSAO_EXPIRADA' : 'PENDENCIA_EXPIRADA',
      });
      expect(await save(input)).toEqual(receipt);
    },
  );
  it('serializes concurrent dispatches, fences duplicate delivery and resumes with a new consumer', async () => {
    const p = await link();
    const a = p.capture('EXPEDICAO');
    const b = p.capture('EXPEDICAO');
    await Promise.all([save(a), save(b)]);
    await save(p.capture('COLETA'));
    await save(p.capture('RECEBIMENTO'));
    const workers = [worker(), worker(), worker()];
    for (let i = 0; i < 4; i++) await Promise.all(workers.map((w) => w.tick()));
    await drain(worker());
    const decisions = await Promise.all([query(a.id), query(b.id)]);
    expect(decisions.filter((d) => d.decisao.autorizada)).toHaveLength(1);
    expect(await db.query("SELECT * FROM movements WHERE type='EXPEDICAO'")).toHaveLength(1);
    const event = (
      await db.query(
        "SELECT id FROM outbox WHERE status='PROCESSED' AND envelope->>'type'='ObservacaoProcessada' LIMIT 1",
      )
    )[0];
    const before = await db.query(
      'SELECT * FROM decision_revisions ORDER BY observation_id,revision',
    );
    await db.query("UPDATE outbox SET status='PENDING',attempts=0 WHERE id=$1", [event.id]);
    await drain(worker());
    expect(
      await db.query('SELECT * FROM decision_revisions ORDER BY observation_id,revision'),
    ).toEqual(before);
    expect(
      (await db.query('SELECT count(*) FROM audit_log WHERE event_id=$1', [event.id]))[0].count,
    ).toBe('1');
  });
  it('rolls back state, revision, movement, outbox, audit and inbox jointly, then recovers', async () => {
    const p = await link();
    const input = p.capture('RECEBIMENTO');
    await save(input);
    await drain();
    const collection = p.capture('COLETA');
    await save(collection);
    const w = worker(new SystemClock(), true);
    const claims = await w.claim();
    const claim = claims.find(
      (c) => c.envelope.type === 'ObservacaoProcessada' && c.envelope.aggregateId === collection.id,
    )!;
    const count = (await db.query('SELECT count(*) FROM outbox'))[0].count;
    await w.deliver(claim);
    expect((await query(input.id)).decisao).toMatchObject({ status: 'PENDENTE', revisao: 1 });
    expect((await state(p.orderId)).estado).toBe('COLETADO');
    expect(
      await db.query('SELECT * FROM movements WHERE observation_id=$1', [input.id]),
    ).toHaveLength(0);
    expect((await db.query('SELECT count(*) FROM outbox'))[0].count).toBe(count);
    expect(await db.query('SELECT * FROM inbox WHERE event_id=$1', [claim.id])).toHaveLength(0);
    expect(await db.query('SELECT * FROM audit_log WHERE event_id=$1', [claim.id])).toHaveLength(0);
    await db.query(
      "UPDATE outbox SET available_at=clock_timestamp(),locked_until=clock_timestamp()-interval '1 second' WHERE status IN ('PENDING','PROCESSING') AND envelope->>'type'<>'ReconciliacaoPrazo'",
    );
    await drain(worker());
    expect((await query(input.id)).decisao.status).toBe('AUTORIZADA');
    expect(
      await db.query('SELECT * FROM movements WHERE observation_id=$1', [input.id]),
    ).toHaveLength(1);
  });
  it('rejects pending old operations when the order has already been delivered by online captures', async () => {
    const p = await link();
    const pending = p.capture('EXPEDICAO');
    await save(pending);
    for (const type of ['COLETA', 'RECEBIMENTO', 'ENTREGA']) await save(p.capture(type));
    await drain();
    expect((await query(pending.id)).decisao).toMatchObject({
      status: 'REJEITADA',
      motivo: 'PEDIDO_JA_ENTREGUE',
      estadoResultante: 'ENTREGUE',
    });
    expect((await state(p.orderId)).estado).toBe('ENTREGUE');
    expect(
      await db.query('SELECT * FROM movements WHERE observation_id=$1', [pending.id]),
    ).toHaveLength(0);
  });
  it('never schedules unauthenticated SDM evidence even for a future step', async () => {
    const p = await link('SDM');
    const input = p.capture('RECEBIMENTO');
    input.leituraBruta.bytesBase64 = Buffer.from(input.leituraBruta.bytesBase64!, 'base64')
      .subarray(0, 12)
      .toString('base64');
    expect((await save(input)).decisao).toMatchObject({
      status: 'REJEITADA',
      motivo: 'SDM_INVALIDA',
      evidencia: 'INVALIDA',
    });
    await save(p.capture('COLETA'));
    await drain();
    expect((await query(input.id)).decisao.revisao).toBe(1);
  });
  it('migrates old receipts without mutating them or retrospectively promoting rejections', async () => {
    const p = await link();
    const input = p.capture('RECEBIMENTO');
    const receipt = await save(input);
    const runner = db.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      const migration = new Reconciliation1790000003000();
      await migration.down(runner);
      const legacyId = randomUUID();
      const legacy = {
        accepted: false,
        reason: 'SEQUENCIA_INVALIDA',
        classification: 'REGULAR',
        evidence: 'IDENTIFICADA',
        stateChanged: false,
        previousState: 'CADASTRADO',
        resultingState: 'CADASTRADO',
        warnings: [],
      };
      await runner.query(
        `INSERT INTO observations(id,order_id,provisioning_id,strategy,fingerprint,input,received_at)
        SELECT $1::uuid,order_id,provisioning_id,strategy,fingerprint,input || jsonb_build_object('id',$1::uuid::text),received_at
        FROM observations WHERE id=$2`,
        [legacyId, input.id],
      );
      await runner.query('INSERT INTO decisions(observation_id,result) VALUES ($1,$2)', [
        legacyId,
        legacy,
      ]);
      await migration.up(runner);
      expect(
        (await runner.query('SELECT result FROM decisions WHERE observation_id=$1', [legacyId]))[0]
          .result,
      ).toEqual(legacy);
      const backfill = (
        await runner.query('SELECT result FROM decision_revisions WHERE observation_id=$1', [
          legacyId,
        ])
      )[0].result;
      expect(backfill).toMatchObject({
        ...legacy,
        status: 'REJEITADA',
        revision: 1,
        dependencies: [],
        expiresAt: null,
      });
      expect(
        (
          await runner.query('SELECT status FROM current_decisions WHERE observation_id=$1', [
            legacyId,
          ])
        )[0].status,
      ).toBe('REJEITADA');
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
    expect(await save(input)).toEqual(receipt);
    await expect(
      db.query("UPDATE decision_revisions SET result='{}' WHERE observation_id=$1", [input.id]),
    ).rejects.toThrow('append-only');
    await expect(
      db.query('DELETE FROM decision_revisions WHERE observation_id=$1', [input.id]),
    ).rejects.toThrow('append-only');
    await expect(
      db.query('UPDATE current_decisions SET revision=revision WHERE observation_id=$1', [
        input.id,
      ]),
    ).rejects.toThrow('must advance');
  });
});
