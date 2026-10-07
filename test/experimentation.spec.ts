import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { createHttpApplication } from '../src/bootstrap/application';
import { readConfig } from '../src/bootstrap/config';
import { testDatabase, resetDatabase, seedIdentity } from './support';
import {
  Dataset,
  RunInput,
  TrialInput,
  ClientRecordInput,
} from '../src/bounded-contexts/experimentation/domain/types';
import {
  validateDataset,
  summarizeDataset,
} from '../src/bounded-contexts/experimentation/domain/dataset';
import { datasetCsv } from '../src/bounded-contexts/experimentation/domain/csv';
import { Sha256Fingerprint } from '../src/platform/runtime';
describe('Experimental instrumentation / real PostgreSQL, synthetic data', () => {
  let db: DataSource,
    app: INestApplication,
    admin: Awaited<ReturnType<typeof seedIdentity>>,
    operator: Awaited<ReturnType<typeof seedIdentity>>;
  const post = (path: string, body: object, token = admin.token) =>
    request(app.getHttpServer())
      .post('/api/v1' + path)
      .auth(token, { type: 'bearer' })
      .send(body);
  const get = (path: string, token = admin.token) =>
    request(app.getHttpServer())
      .get('/api/v1' + path)
      .auth(token, { type: 'bearer' });
  beforeAll(async () => {
    db = await testDatabase();
    app = await createHttpApplication(
      readConfig({ DATABASE_URL: 'postgresql://unused@localhost/test', APP_PROCESS_ROLE: 'api' }),
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
    admin = await seedIdentity(db);
    operator = await seedIdentity(db, 'OPERADOR');
  });
  async function plan() {
    const order = (await post('/pedidos', { codigo: randomUUID() }).expect(201)).body.dados;
    const provisioning = (
      await post('/etiquetas', {
        pedidoId: order.id,
        uid: '04AABBCCDDEE01',
        modelo: 'SYNTHETIC',
        estrategia: 'UID',
      }).expect(201)
    ).body.dados;
    await post('/provisionamentos/' + provisioning.id + '/ativacao', {
      bloqueioConfirmado: true,
    }).expect(200);
    const run: RunInput = {
      id: randomUUID(),
      name: 'Synthetic acceptance',
      dataKind: 'SINTETICO',
      protocolVersion: 'instrumentation.v1',
      apiVersion: 'test-sha',
      mobileVersion: 'test-sha',
      configuration: {
        tagModel: 'SYNTHETIC',
        antenna: 'fixture',
        position: 'fixture',
        surface: 'fixture',
        phoneCase: 'fixture',
        timeoutMs: 1000,
      },
    };
    await post('/experimentos', run).expect(201);
    const trial: TrialInput = {
      id: randomUUID(),
      runId: run.id,
      sessionId: randomUUID(),
      tagLabel: 'tag-1',
      boxLabel: 'box-1',
      deviceId: 'fixture-phone',
      deviceModel: 'synthetic',
      osVersion: 'synthetic',
      provisioningId: provisioning.id,
      treatment: 'UID',
      policy: null,
      scenario: 'LEGITIMO_ONLINE',
      mode: 'SINTETICA',
      ordinal: 1,
      eventType: 'COLETA',
    };
    const dto = Object.fromEntries(Object.entries(trial).filter(([key]) => key !== 'runId'));
    await post('/experimentos/' + run.id + '/tentativas', dto).expect(201);
    return { run, trial, provisioning };
  }
  function record(
    trial: TrialInput,
    attemptId: string,
    stage: ClientRecordInput['stage'],
    observationId: string | null = null,
  ): ClientRecordInput {
    return {
      id: randomUUID(),
      trialId: trial.id,
      attemptId,
      stage,
      observationId,
      deviceId: trial.deviceId,
      occurredAt: '1999-01-01T00:00:00Z',
      clockId: randomUUID(),
      monotonicMs: 10,
      durationMs: stage === 'LEITURA_OK' || stage === 'LEITURA_FALHOU' ? 5 : null,
      boundary:
        stage === 'LEITURA_OK' || stage === 'LEITURA_FALHOU'
          ? 'SESSAO_NFC_ATE_EVIDENCIA'
          : 'INSTANTE',
      code: null,
    };
  }
  it('uses operator credentials for captures, denies plan/truth/export, fences revocation and preserves idempotency', async () => {
    const { run, trial } = await plan();
    await post('/experimentos', { ...run, id: randomUUID() }, operator.token).expect(403);
    const spec = await request(app.getHttpServer()).get('/openapi.json').expect(200);
    expect(
      spec.body.paths['/api/v1/experimentos/{id}/exportacao'].get.responses['200'].content[
        'application/json'
      ].schema.properties.dados.$ref,
    ).toContain('ExperimentExport');
    expect(spec.body.components.schemas.TruthDto.required).toContain('observedOrdinal');
    await get('/experimentos/' + run.id + '/exportacao', operator.token).expect(403);
    await post(
      '/experimentos/tentativas/' + trial.id + '/observacao-independente',
      {},
      operator.token,
    ).expect(403);
    const input = record(trial, randomUUID(), 'TENTATIVA_INICIADA');
    const first = (await post('/experimentos/registros', input, operator.token).expect(200)).body;
    expect((await post('/experimentos/registros', input, operator.token).expect(200)).body).toEqual(
      first,
    );
    await post('/experimentos/registros', { ...input, monotonicMs: 11 }, operator.token).expect(
      409,
    );
    await post('/experimentos/registros', input, admin.token).expect(409);
    await post(
      '/experimentos/registros',
      { ...input, id: randomUUID(), senha: 'should-never-persist' },
      operator.token,
    ).expect(400);
    await db.query('UPDATE identity_sessions SET revoked_at=clock_timestamp() WHERE user_id=$1', [
      operator.id,
    ]);
    await post('/experimentos/registros', { ...input, id: randomUUID() }, operator.token).expect(
      401,
    );
    expect((await db.query('SELECT COUNT(*) FROM experiment_client_records'))[0].count).toBe('1');
  });
  it('exports failed reads, independent truth revisions, original decisions and monotonic spans without any mutation', async () => {
    const { run, trial, provisioning } = await plan();
    const attempt = randomUUID();
    const id = randomUUID();
    for (const input of [
      record(trial, attempt, 'TENTATIVA_INICIADA'),
      record(trial, attempt, 'LEITURA_OK'),
      record(trial, attempt, 'CAPTURA_LOCAL', id),
    ])
      await post('/experimentos/registros', input, operator.token).expect(200);
    const capture = {
      id,
      versaoContrato: 1,
      provisionamentoId: provisioning.id,
      tipo: 'COLETA',
      ocorridoEm: '2030-01-01T00:00:00Z',
      dispositivoId: trial.deviceId,
      leituraBruta: { uid: provisioning.uid },
    };
    await post('/eventos', capture, operator.token).expect(200);
    await post('/eventos', capture, operator.token).expect(200);
    const failed = randomUUID();
    await post(
      '/experimentos/registros',
      record(trial, failed, 'TENTATIVA_INICIADA'),
      operator.token,
    ).expect(200);
    await post(
      '/experimentos/registros',
      { ...record(trial, failed, 'LEITURA_FALHOU'), code: 'NFC_TIMEOUT' },
      operator.token,
    ).expect(200);
    const truth = {
      id: randomUUID(),
      legitimate: true,
      shouldAuthorize: true,
      observedBox: 'box-1',
      observedTag: 'tag-1',
      observedOrdinal: 1,
      observedAt: '2026-10-07T00:00:00Z',
      source: 'ROTEIRO_SINTETICO',
      excluded: false,
      exclusionReason: 'NAO_EXCLUIDA',
    };
    const path = '/experimentos/tentativas/' + trial.id + '/observacao-independente';
    expect((await post(path, truth).expect(201)).body.dados.revision).toBe(1);
    expect((await post(path, truth).expect(201)).body.dados.revision).toBe(1);
    expect(
      (
        await post(path, {
          ...truth,
          id: randomUUID(),
          legitimate: false,
          shouldAuthorize: false,
        }).expect(201)
      ).body.dados.revision,
    ).toBe(2);
    const snapshot = async () =>
      JSON.stringify(
        await db.query(
          'SELECT (SELECT COUNT(*) FROM observations) AS o,(SELECT COUNT(*) FROM decision_revisions) AS d,(SELECT COUNT(*) FROM outbox) AS q,(SELECT COUNT(*) FROM operation_measurements) AS m,(SELECT COUNT(*) FROM experiment_client_records) AS c',
        ),
      );
    const before = await snapshot();
    const exported = (await get('/experimentos/' + run.id + '/exportacao').expect(200)).body.dados;
    expect(await snapshot()).toBe(before);
    expect(exported.checksum).toBe(new Sha256Fingerprint().of(exported.dataset));
    expect(exported.integrity.status).toBe('COMPLETO');
    expect(exported.summary[0]).toMatchObject({
      readAttempts: 2,
      readSuccess: 1,
      readFailures: 1,
      storedCaptures: 1,
      authorized: 1,
      falseAccepts: 1,
      falseAcceptDenominator: 1,
    });
    expect(exported.dataset.serverMeasurements).toHaveLength(2);
    expect(exported.metrics[0]).toMatchObject({
      physicalReadSuccess: { numerator: 0, denominator: 0, value: null },
      readStageSuccess: { numerator: 1, denominator: 2, value: 0.5 },
      falseAcceptance: { numerator: 1, denominator: 1, value: 1 },
    });
    expect(exported.dataset.observations[0].declaredAt).toBe('2030-01-01T00:00:00.000Z');
    expect(exported.summary[0].durations.every((s: { ms: number }) => s.ms >= 0)).toBe(true);
    expect(JSON.stringify(exported)).not.toMatch(
      /password_hash|token_hash|tokenAcesso|sealed|masterKeys/,
    );
    expect(JSON.stringify(exported)).not.toContain(operator.token);
    for (const table of [
      'experiment_runs',
      'experiment_trials',
      'experiment_ground_truth',
      'experiment_client_records',
      'operation_measurements',
    ])
      await expect(db.query('DELETE FROM ' + table)).rejects.toThrow('append-only');
    const csv = datasetCsv(exported.dataset as Dataset);
    expect(csv['client-stages.csv']).toContain('NFC_TIMEOUT');
    expect(csv['server-measurements.csv']).toContain('"ms"');
    const corrupt = structuredClone(exported.dataset) as Dataset;
    corrupt.observations[0]!.movements.push({
      ...corrupt.observations[0]!.movements[0]!,
      id: randomUUID(),
    });
    expect(validateDataset(corrupt).errors).toContain('EFEITO_DIVERGENTE:' + id);
    expect(summarizeDataset(corrupt)[0]!.duplicateEffects).toBe(1);
    const formula = structuredClone(exported.dataset) as Dataset;
    formula.trials[0]!.input.boxLabel = '=1+1';
    expect(datasetCsv(formula)['trials.csv']).toContain('"\'=1+1"');
  });
  it('detects missing records, malformed files, inconsistent effects and physical/synthetic mixing', async () => {
    const { run, trial } = await plan();
    const exported = (await get('/experimentos/' + run.id + '/exportacao').expect(200)).body.dados;
    expect(exported.integrity.status).toBe('INCOMPLETO');
    expect(validateDataset({ ...exported.dataset, trials: [null] }).status).toBe('INCONSISTENTE');
    const dto = Object.fromEntries(Object.entries(trial).filter(([key]) => key !== 'runId'));
    await post('/experimentos/' + run.id + '/tentativas', {
      ...dto,
      id: randomUUID(),
      mode: 'LEITURA_FISICA',
      ordinal: 2,
    }).expect(400);
    await post('/experimentos/tentativas/' + trial.id + '/observacao-independente', {
      id: randomUUID(),
      legitimate: true,
      shouldAuthorize: true,
      observedBox: 'box-1',
      observedTag: 'tag-1',
      observedOrdinal: 1,
      observedAt: '2026-10-07T00:00:00Z',
      source: 'OBSERVADOR',
      excluded: false,
      exclusionReason: 'NAO_EXCLUIDA',
    }).expect(400);
    const local = record(trial, randomUUID(), 'CAPTURA_LOCAL', randomUUID());
    await post('/experimentos/registros', local, operator.token).expect(200);
    const d = (await get('/experimentos/' + run.id + '/exportacao').expect(200)).body.dados.dataset;
    expect(validateDataset(d).errors.join(',')).toContain('CAPTURA_SEM_LEITURA_COMPLETA');
    expect(validateDataset(d).warnings.join(',')).toContain('CAPTURA_SEM_SERVIDOR');
    expect(summarizeDataset(d)[0]).toMatchObject({ localCaptures: 1, storedCaptures: 0 });
  });
  it('rolls back state, observations, decisions, measurements and outbox if instrumentation cannot persist', async () => {
    const { provisioning } = await plan();
    const before = (await db.query('SELECT COUNT(*) FROM outbox'))[0].count;
    await db.query(
      "CREATE FUNCTION fixture_measurement_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced instrumentation failure'; END $$;CREATE TRIGGER fixture_measurement_failure BEFORE INSERT ON operation_measurements FOR EACH ROW EXECUTE FUNCTION fixture_measurement_failure();",
    );
    const input = {
      id: randomUUID(),
      versaoContrato: 1,
      provisionamentoId: provisioning.id,
      tipo: 'COLETA',
      ocorridoEm: '2026-10-07T00:00:00Z',
      dispositivoId: 'fixture-phone',
      leituraBruta: { uid: provisioning.uid },
    };
    try {
      await post('/eventos', input, operator.token).expect(500);
    } finally {
      await db.query(
        'DROP TRIGGER fixture_measurement_failure ON operation_measurements;DROP FUNCTION fixture_measurement_failure();',
      );
    }
    expect(await db.query('SELECT * FROM observations')).toHaveLength(0);
    expect(await db.query('SELECT * FROM operation_measurements')).toHaveLength(0);
    expect((await db.query('SELECT COUNT(*) FROM outbox'))[0].count).toBe(before);
    expect((await get('/pedidos/' + provisioning.pedidoId)).body.dados.estado).toBe('CADASTRADO');
    await post('/eventos', input, operator.token).expect(200);
    expect(await db.query('SELECT * FROM operation_measurements')).toHaveLength(2);
  });
});
