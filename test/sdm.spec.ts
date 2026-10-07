import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, unlinkSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createHttpApplication } from '../src/bootstrap/application';
import { readConfig } from '../src/bootstrap/config';
import {
  NodeSdmCryptography,
  sdmMessage,
} from '../src/bounded-contexts/traceability/infrastructure/sdm-crypto';
import { SdmConfiguration } from '../src/bounded-contexts/traceability/domain/sdm';
import { SealedSdmKeys } from '../src/bounded-contexts/traceability/application/sdm-ports';
import { UnitOfWork } from '../src/bounded-contexts/traceability/application/ports';
import { TypeOrmUnitOfWork } from '../src/bounded-contexts/traceability/infrastructure/typeorm-unit-of-work';
import { RecordObservation } from '../src/bounded-contexts/traceability/application/record-observation';
import { ActivateProvisioning } from '../src/bounded-contexts/traceability/application/change-provisioning';
import { ProvisionTag } from '../src/bounded-contexts/traceability/application/provision-tag';
import { NodeIds, Sha256Fingerprint, SystemClock } from '../src/platform/runtime';
import { OutboxDispatcher } from '../src/platform/messaging/outbox-dispatcher';
import { AuditConsumer } from '../src/platform/audit/audit-consumer';
import { testDatabase, resetDatabase, seedIdentity } from './support';
import { syntheticSdmReading } from './sdm-fixtures';
import { nfcLifecycleGate } from '../src/platform/access/nfc-lifecycle-gate';
import { EventType } from '../src/bounded-contexts/traceability/domain/types';

const uid = '04AABBCCDDEE01';
type Link = { id: string; orderId: string; sdm: SdmConfiguration; sealed: SealedSdmKeys };
describe('SDM synthetic contract with real PostgreSQL and HTTP (no physical acceptance)', () => {
  let source: DataSource;
  let app: INestApplication;
  let token: string;
  const masters = JSON.stringify({ '1': randomBytes(32).toString('base64') });
  const vault = new NodeSdmCryptography('1', masters);
  const ids = new NodeIds();
  const clock = new SystemClock();
  const http = () => ({
    get: (path: string) => request(app.getHttpServer()).get(path).auth(token, { type: 'bearer' }),
    post: (path: string) => request(app.getHttpServer()).post(path).auth(token, { type: 'bearer' }),
  });
  beforeAll(async () => {
    source = await testDatabase();
    app = await createHttpApplication(
      readConfig({
        DATABASE_URL: 'postgresql://unused@localhost/test',
        APP_PROCESS_ROLE: 'api',
        SDM_ACTIVE_MASTER_VERSION: '1',
        SDM_MASTER_KEYS_JSON: masters,
      }),
      source,
      false,
      true,
    );
  });
  beforeEach(async () => {
    await resetDatabase(source);
    token = (await seedIdentity(source)).token;
  });
  afterAll(async () => {
    await app?.close();
    if (source?.isInitialized) await source.destroy();
  });
  async function order() {
    return (
      await http()
        .post('/api/v1/pedidos')
        .send({ codigo: `SDM-${randomUUID()}` })
        .expect(201)
    ).body.dados.id as string;
  }
  async function link(policy = 'ESTRITA', active = true): Promise<Link> {
    const orderId = await order();
    const response = await http()
      .post('/api/v1/etiquetas')
      .send({
        pedidoId: orderId,
        uid,
        modelo: 'NTAG424DNA',
        estrategia: 'SDM',
        politicaSdm: policy,
      })
      .expect(201);
    const id = response.body.dados.id as string;
    expect(response.body.dados.sdm).toMatchObject({
      politica: policy,
      perfilCandidato: true,
      versaoChaves: 1,
    });
    const sdm = (await source.query('SELECT sdm FROM provisionings WHERE id=$1', [id]))[0]
      .sdm as SdmConfiguration;
    const sealed = (
      await source.query('SELECT sealed FROM sdm_keys WHERE provisioning_id=$1', [id])
    )[0].sealed as SealedSdmKeys;
    const p = { id, orderId, sdm, sealed };
    if (active)
      await http()
        .post(`/api/v1/provisionamentos/${id}/ativacao`)
        .send({ bloqueioConfirmado: true, leituraSdm: reading(p, 1) })
        .expect(200);
    return p;
  }
  function reading(p: Link, counter: number, options?: Parameters<typeof syntheticSdmReading>[6]) {
    return syntheticSdmReading(vault, p.id, p.sdm, p.sealed, uid, counter, options);
  }
  function capture(p: Link, counter: number, tipo: EventType = 'COLETA') {
    return {
      id: randomUUID(),
      versaoContrato: 1 as const,
      provisionamentoId: p.id,
      tipo,
      ocorridoEm: '2026-10-07T12:00:00.000Z',
      dispositivoId: 'synthetic-sdm',
      leituraBruta: reading(p, counter),
    };
  }
  const maximum = async (p: Link) =>
    (
      await source.query('SELECT maximum FROM sdm_counter_state WHERE provisioning_id=$1', [p.id])
    )[0].maximum as number;
  const breakingUow = (): UnitOfWork => ({
    run: (work) =>
      new TypeOrmUnitOfWork(source, undefined, nfcLifecycleGate).run((tx) =>
        work({
          ...tx,
          outbox: {
            append: async () => {
              throw new Error('forced outbox failure');
            },
          },
        }),
      ),
  });

  it('requires explicit policy, trusted keys, seven-byte UID and rejects client epoch/profile overrides', async () => {
    const orderId = await order();
    for (const extra of [
      {},
      { politicaSdm: 'ESTRITA', epoca: 1 },
      { politicaSdm: 'ESTRITA', perfil: 'other' },
    ])
      await http()
        .post('/api/v1/etiquetas')
        .send({ pedidoId: orderId, uid, modelo: 'NTAG424DNA', estrategia: 'SDM', ...extra })
        .expect(400);
    await http()
      .post('/api/v1/etiquetas')
      .send({
        pedidoId: orderId,
        uid: '00112233',
        modelo: 'NTAG424DNA',
        estrategia: 'SDM',
        politicaSdm: 'ESTRITA',
      })
      .expect(400);
    await http()
      .post('/api/v1/etiquetas')
      .send({
        pedidoId: orderId,
        uid,
        modelo: 'NTAG424DNA',
        estrategia: 'UID',
        politicaSdm: 'ESTRITA',
      })
      .expect(400);
    const unavailable = new ProvisionTag(
      new TypeOrmUnitOfWork(source),
      clock,
      ids,
      new NodeSdmCryptography(),
    );
    await expect(
      unavailable.execute(
        { pedidoId: orderId, uid, modelo: 'NTAG424DNA', estrategia: 'SDM', politicaSdm: 'ESTRITA' },
        'test',
      ),
    ).rejects.toMatchObject({ kind: 'unavailable' });
    expect(await source.query('SELECT * FROM provisionings')).toHaveLength(0);
  });
  it('activates once using cryptographic proof and reserves the activation counter', async () => {
    const p = await link('ESTRITA', false);
    await http()
      .post(`/api/v1/provisionamentos/${p.id}/ativacao`)
      .send({ bloqueioConfirmado: true })
      .expect(400);
    await http()
      .post(`/api/v1/provisionamentos/${p.id}/ativacao`)
      .send({ bloqueioConfirmado: true, leituraSdm: reading(p, 1, { wrongKey: true }) })
      .expect(400);
    expect(await maximum(p)).toBe(-1);
    const proof = { bloqueioConfirmado: true, leituraSdm: reading(p, 1) };
    const responses = await Promise.all(
      [1, 2].map(() =>
        http().post(`/api/v1/provisionamentos/${p.id}/ativacao`).send(proof).expect(200),
      ),
    );
    expect(responses[0]!.body.dados).toEqual(responses[1]!.body.dados);
    expect(await source.query("SELECT * FROM movements WHERE type='PROVISIONAMENTO'")).toHaveLength(
      1,
    );
    const result = await http().post('/api/v1/eventos').send(capture(p, 1)).expect(200);
    expect(result.body.dados.decisao).toMatchObject({
      autorizada: false,
      motivo: 'SDM_EVIDENCIA_REUTILIZADA',
      sdm: { autenticada: true, previamenteUtilizada: true },
    });
  });
  it('retains invalid evidence without changing counters, and prevents any UID/static fallback', async () => {
    const p = await link();
    const valid = reading(p, 2);
    const tampered = valid.ndef.replace(
      /picc_data=(.)/,
      (_match, char: string) => 'picc_data=' + (char === '0' ? '1' : '0'),
    );
    const candidates = [
      syntheticSdmReading(vault, p.id, p.sdm, p.sealed, '04AABBCCDDEE02', 2),
      { ...valid, ndef: tampered, bytesBase64: sdmMessage(tampered).toString('base64') },
      reading(p, 2, { wrongKey: true }),
      reading(p, 2, { piccTag: 0xc6 }),
      { ...valid, bytesBase64: undefined },
      {
        ...valid,
        bytesBase64: Buffer.concat([
          Buffer.from([0, 127]),
          Buffer.from(valid.bytesBase64, 'base64'),
        ]).toString('base64'),
      },
      { ...valid, ndef: `urn:nfc-trace:provisioning:${p.id}` },
      { ...valid, bytesBase64: sdmMessage(valid.ndef).subarray(1).toString('base64') },
      { ...valid, ndef: valid.ndef + '&x=1' },
    ];
    for (const raw of candidates) {
      const result = await http()
        .post('/api/v1/eventos')
        .send({ ...capture(p, 2), leituraBruta: raw })
        .expect(200);
      expect(result.body.dados.decisao).toMatchObject({
        autorizada: false,
        motivo: 'SDM_INVALIDA',
        sdm: { autenticada: false, contador: null },
      });
    }
    expect(await maximum(p)).toBe(1);
    expect(await source.query('SELECT * FROM sdm_evidence')).toHaveLength(1);
    const validLower = await http()
      .post('/api/v1/eventos')
      .send({ ...capture(p, 2), leituraBruta: reading(p, 2, { lowerCase: true }) })
      .expect(200);
    expect(validLower.body.dados.decisao.autorizada).toBe(true);
  });
  it('returns the original receipt for the same UUID, conflicts on changed payload, and consumes evidence across UUIDs', async () => {
    const p = await link();
    const input = capture(p, 2);
    const first = await http().post('/api/v1/eventos').send(input).expect(200);
    const repeat = await http().post('/api/v1/eventos').send(input).expect(200);
    expect(repeat.body).toEqual(first.body);
    await http()
      .post('/api/v1/eventos')
      .send({ ...input, tipo: 'MOVIMENTACAO' })
      .expect(409);
    const replay = await http()
      .post('/api/v1/eventos')
      .send({ ...input, id: randomUUID() })
      .expect(200);
    expect(replay.body.dados.decisao.motivo).toBe('SDM_EVIDENCIA_REUTILIZADA');
    expect(await maximum(p)).toBe(2);
    expect(await source.query("SELECT * FROM movements WHERE type='COLETA'")).toHaveLength(1);
  });
  it('serializes different UUIDs racing for the same authenticated counter', async () => {
    const p = await link();
    // Different padding/ciphertext does not allow reuse of the authenticated counter.
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        http().post('/api/v1/eventos').send(capture(p, 2)).expect(200),
      ),
    );
    expect(results.filter((r) => r.body.dados.decisao.autorizada)).toHaveLength(1);
    expect(
      results.filter((r) => r.body.dados.decisao.motivo === 'SDM_EVIDENCIA_REUTILIZADA'),
    ).toHaveLength(7);
    expect(await source.query('SELECT * FROM sdm_evidence')).toHaveLength(2);
  });
  it.each(['ESTRITA', 'REGISTRO_TARDIO'])(
    'fixes %s policy and preserves unseen lower counters without automatic logistics',
    async (policy) => {
      const p = await link(policy);
      await http().post('/api/v1/eventos').send(capture(p, 10)).expect(200);
      const result = await http()
        .post('/api/v1/eventos')
        .send(capture(p, 5, 'RECEBIMENTO'))
        .expect(200);
      expect(result.body.dados.decisao).toMatchObject({
        autorizada: false,
        motivo: policy === 'ESTRITA' ? 'SDM_CONTADOR_NAO_CRESCENTE' : 'SDM_REGISTRO_TARDIO',
        classificacao: policy === 'ESTRITA' ? 'SUSPEITO' : 'REGULAR',
        sdm: {
          autenticada: true,
          previamenteUtilizada: false,
          temporalidade: 'TARDIA',
          maiorContadorAnterior: 10,
        },
      });
      expect((await http().get(`/api/v1/pedidos/${p.orderId}`)).body.dados.estado).toBe('COLETADO');
      expect(await maximum(p)).toBe(10);
      const repeated = await http()
        .post('/api/v1/eventos')
        .send(capture(p, 5, 'RECEBIMENTO'))
        .expect(200);
      expect(repeated.body.dados.decisao.motivo).toBe('SDM_EVIDENCIA_REUTILIZADA');
      await expect(
        source.query(
          "UPDATE provisionings SET sdm=jsonb_set(sdm,'{policy}', to_jsonb($2::text)) WHERE id=$1",
          [p.id, policy === 'ESTRITA' ? 'REGISTRO_TARDIO' : 'ESTRITA'],
        ),
      ).rejects.toThrow();
    },
  );
  it('reserves authenticated evidence even on logistics rejection and distinguishes raw UID divergence', async () => {
    const p = await link();
    const rejected = await http()
      .post('/api/v1/eventos')
      .send(capture(p, 2, 'ENTREGA'))
      .expect(200);
    expect(rejected.body.dados.decisao).toMatchObject({
      autorizada: false,
      sdm: { autenticada: true },
    });
    const copied = await http()
      .post('/api/v1/eventos')
      .send({ ...capture(p, 3), leituraBruta: { ...reading(p, 3), uid: '00112233445566' } })
      .expect(200);
    expect(copied.body.dados.decisao).toMatchObject({
      autorizada: true,
      classificacao: 'SUSPEITO',
      avisos: ['UID_DIVERGENTE'],
      sdm: { autenticada: true },
    });
    const reuse = await http().post('/api/v1/eventos').send(capture(p, 2)).expect(200);
    expect(reuse.body.dados.decisao.motivo).toBe('SDM_EVIDENCIA_REUTILIZADA');
    const history = await http().get(`/api/v1/pedidos/${p.orderId}/eventos`).expect(200);
    expect(
      history.body.dados.itens.filter((entry: { decisao: { sdm?: unknown } }) => entry.decisao.sdm),
    ).toHaveLength(3);
  });
  it('rolls back evidence, maximum, decision, movement, state and outbox together, then permits retry', async () => {
    const p = await link();
    const count = (await source.query('SELECT count(*) FROM outbox'))[0].count;
    const input = capture(p, 2);
    const command = new RecordObservation(
      breakingUow(),
      clock,
      ids,
      new Sha256Fingerprint(),
      vault,
    );
    await expect(command.execute(input, 'rollback')).rejects.toThrow('forced');
    expect(await maximum(p)).toBe(1);
    expect(await source.query('SELECT * FROM observations')).toHaveLength(0);
    expect((await source.query('SELECT count(*) FROM outbox'))[0].count).toBe(count);
    expect((await http().get(`/api/v1/pedidos/${p.orderId}`)).body.dados.estado).toBe('CADASTRADO');
    const response = await http().post('/api/v1/eventos').send(input).expect(200);
    expect(response.body.dados.decisao.autorizada).toBe(true);
  });
  it('rolls back failed activation including proof consumption', async () => {
    const p = await link('ESTRITA', false);
    await expect(
      new ActivateProvisioning(breakingUow(), clock, ids, vault).execute(
        p.id,
        { bloqueioConfirmado: true, leituraSdm: reading(p, 1) },
        'rollback',
      ),
    ).rejects.toThrow('forced');
    expect(await maximum(p)).toBe(-1);
    expect(await source.query('SELECT * FROM sdm_evidence')).toHaveLength(0);
    expect((await http().get(`/api/v1/provisionamentos/${p.id}`)).body.dados.status).toBe(
      'REGISTRADA',
    );
  });
  it('closes an epoch, creates distinct keys, and refuses evidence from previous epochs', async () => {
    const old = await link();
    const oldCapture = capture(old, 2);
    await http().post(`/api/v1/provisionamentos/${old.id}/encerramento`).expect(200);
    const next = await link();
    expect(next.sdm.keyReference).not.toBe(old.sdm.keyReference);
    const closed = await http().post('/api/v1/eventos').send(oldCapture).expect(200);
    expect(closed.body.dados.decisao.motivo).toBe('VINCULO_INATIVO');
    const staleUri = oldCapture.leituraBruta.ndef.replace(old.id, next.id);
    const mismatch = await http()
      .post('/api/v1/eventos')
      .send({
        ...capture(next, 2),
        leituraBruta: {
          ...oldCapture.leituraBruta,
          ndef: staleUri,
          bytesBase64: sdmMessage(staleUri).toString('base64'),
        },
      })
      .expect(200);
    expect(mismatch.body.dados.decisao.motivo).toBe('SDM_INVALIDA');
    expect((await http().get(`/api/v1/provisionamentos/${next.id}`)).body.dados.epoca).toBe(2);
    await expect(
      source.query("UPDATE provisionings SET strategy='UID',sdm=null WHERE id=$1", [next.id]),
    ).rejects.toThrow();
    expect(await maximum(next)).toBe(1);
  });
  it('recovers encrypted server keys without losing counters and does not expose secrets in HTTP or audit', async () => {
    const p = await link();
    const input = capture(p, 2);
    await http().post('/api/v1/eventos').send(input).expect(200);
    const next = new NodeSdmCryptography('1', masters);
    const result = await new RecordObservation(
      new TypeOrmUnitOfWork(source),
      clock,
      ids,
      new Sha256Fingerprint(),
      next,
    ).execute({ ...input, id: randomUUID() }, 'restart');
    expect(result.decisao.motivo).toBe('SDM_EVIDENCIA_REUTILIZADA');
    const broken = new NodeSdmCryptography(
      '2',
      JSON.stringify({ '2': randomBytes(32).toString('base64') }),
    );
    await expect(
      new RecordObservation(
        new TypeOrmUnitOfWork(source),
        clock,
        ids,
        new Sha256Fingerprint(),
        broken,
      ).execute(capture(p, 3), 'missing-master'),
    ).rejects.toMatchObject({ kind: 'unavailable' });
    expect(await maximum(p)).toBe(2);
    await new OutboxDispatcher(source, [new AuditConsumer()], {
      batchSize: 25,
      leaseMs: 30000,
    }).tick();
    const publicData = JSON.stringify([
      (await http().get(`/api/v1/provisionamentos/${p.id}`)).body,
      (await http().get(`/api/v1/eventos/${input.id}`)).body,
      await source.query('SELECT payload FROM audit_log'),
    ]);
    const plain = vault.unseal(p.id, p.sdm, p.sealed);
    for (const key of [plain.subarray(0, 16), plain.subarray(16)]) {
      expect(publicData).not.toContain(key.toString('hex'));
      expect(publicData).not.toContain(key.toString('base64'));
    }
    expect(publicData).not.toContain(p.sealed.ciphertext);
  });

  it('runs the six event types with SDM while preserving the same logistics rules', async () => {
    const p = await link();
    const reserved = await http()
      .post('/api/v1/eventos')
      .send(capture(p, 2, 'PROVISIONAMENTO'))
      .expect(200);
    expect(reserved.body.dados.decisao).toMatchObject({
      autorizada: false,
      motivo: 'EVENTO_RESERVADO',
      sdm: { autenticada: true },
    });
    let counter = 3;
    for (const type of ['COLETA', 'RECEBIMENTO', 'MOVIMENTACAO', 'EXPEDICAO', 'ENTREGA'] as const) {
      const result = await http()
        .post('/api/v1/eventos')
        .send(capture(p, counter++, type))
        .expect(200);
      expect(result.body.dados.decisao.autorizada).toBe(true);
    }
    const repeat = await http()
      .post('/api/v1/eventos')
      .send(capture(p, counter, 'COLETA'))
      .expect(200);
    expect(repeat.body.dados.decisao.autorizada).toBe(false);
    expect((await http().get(`/api/v1/pedidos/${p.orderId}`)).body.dados.estado).toBe('ENTREGUE');
    expect(await source.query('SELECT * FROM movements')).toHaveLength(6);
  });

  it('does not mistake first presentation of stored valid evidence for freshness or authenticated operation metadata', async () => {
    const p = await link();
    const storedEvidence = reading(p, 2);
    const requestInput = {
      ...capture(p, 2),
      ocorridoEm: '2000-01-01T00:00:00.000Z',
      dispositivoId: 'unverified-device',
      operadorId: 'declared-arbitrary-person',
      latitude: -12,
      longitude: 34,
      leituraBruta: storedEvidence,
    };
    const answer = await http().post('/api/v1/eventos').send(requestInput).expect(200);
    expect(answer.body.dados.decisao).toMatchObject({
      autorizada: true,
      sdm: { autenticada: true, temporalidade: 'NOVA' },
    });
    expect(answer.body.dados.autoria.usuarioId).not.toBe(requestInput.operadorId);
    expect(answer.body.dados.ocorridoEm).toBe(requestInput.ocorridoEm);
    // MAC authenticates the candidate URI/PICC, not the UUID, event, coordinates, time, operator or device.
  });

  it('exports private material through CLI, rotates the vault atomically and recovers with only the new master', async () => {
    const p = await link('ESTRITA', false);
    const privateFile = resolve(`.tmp/private/cli-tag-${randomUUID()}.json`);
    const masterFile = resolve(`.tmp/private/cli-master-${randomUUID()}.env`);
    const nextMaster = randomBytes(32).toString('base64');
    const ring = JSON.stringify({
      ...(JSON.parse(masters) as Record<string, string>),
      '2': nextMaster,
    });
    const invoke = (args: string[], version = '1', keys = masters) =>
      execFileSync(
        process.execPath,
        ['-r', 'ts-node/register', 'src/platform/access/sdm-keys-cli.ts', ...args],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            DATABASE_URL: source.options.type === 'postgres' ? source.options.url : '',
            SDM_ENV_FILE: resolve('.tmp/nonexistent.env'),
            SDM_ACTIVE_MASTER_VERSION: version,
            SDM_MASTER_KEYS_JSON: keys,
          },
        },
      );
    try {
      const created = invoke(['generate-master', '--version', '3', '--output', masterFile]);
      expect(created).toContain('created');
      expect(readFileSync(masterFile, 'utf8')).toContain('SDM_ACTIVE_MASTER_VERSION=3');
      const exported = invoke(['export', '--provisioning-id', p.id, '--output', privateFile]);
      const material = JSON.parse(readFileSync(privateFile, 'utf8')) as {
        metaRead: { keyHex: string };
        fileRead: { keyHex: string };
        referenciaChaves: string;
      };
      const original = vault.unseal(p.id, p.sdm, p.sealed);
      expect(material.metaRead.keyHex).toBe(original.subarray(0, 16).toString('hex'));
      expect(material.fileRead.keyHex).toBe(original.subarray(16).toString('hex'));
      expect(exported).not.toContain(material.metaRead.keyHex);
      expect(exported).not.toContain(material.fileRead.keyHex);
      expect(() =>
        invoke(['export', '--provisioning-id', p.id, '--output', privateFile]),
      ).toThrow();
      expect(() =>
        invoke(['export', '--provisioning-id', p.id, '--output', 'docs/never-create-secret.json']),
      ).toThrow();
      expect(existsSync('docs/never-create-secret.json')).toBe(false);
      // A missing old master leaves every wrapper unchanged.
      expect(() => invoke(['rewrap'], '2', JSON.stringify({ '2': nextMaster }))).toThrow();
      expect(
        (await source.query('SELECT sealed FROM sdm_keys WHERE provisioning_id=$1', [p.id]))[0]
          .sealed,
      ).toEqual(p.sealed);
      expect(invoke(['rewrap'], '2', ring)).toContain('atomically: 1');
      const sealed = (
        await source.query('SELECT sealed FROM sdm_keys WHERE provisioning_id=$1', [p.id])
      )[0].sealed as SealedSdmKeys;
      const recovered = new NodeSdmCryptography('2', JSON.stringify({ '2': nextMaster }));
      expect(recovered.unseal(p.id, p.sdm, sealed).equals(original)).toBe(true);
      await new ActivateProvisioning(
        new TypeOrmUnitOfWork(source, undefined, nfcLifecycleGate),
        clock,
        ids,
        recovered,
      ).execute(p.id, { bloqueioConfirmado: true, leituraSdm: reading(p, 1) }, 'recovered');
      expect(await maximum(p)).toBe(1);
      await new OutboxDispatcher(source, [new AuditConsumer()], {
        batchSize: 25,
        leaseMs: 30000,
      }).tick();
      const audit = JSON.stringify(await source.query('SELECT payload FROM audit_log'));
      expect(audit).not.toContain(material.metaRead.keyHex);
      expect(audit).not.toContain(material.fileRead.keyHex);
      expect(audit).toContain('CLI_LOCAL');
    } finally {
      for (const file of [privateFile, masterFile]) if (existsSync(file)) unlinkSync(file);
    }
  }, 60000);
});
