// Semantic reproducibility with explicit synthetic evidence, real HTTP/PostgreSQL/SQLite.
// No RF, tag administration, physical protection or experimental inference is simulated as acceptance.
require('reflect-metadata');
require('ts-node').register({
  transpileOnly: true,
  skipProject: true,
  compilerOptions: {
    module: 'CommonJS',
    moduleResolution: 'Node10',
    target: 'ES2022',
    ignoreDeprecations: '6.0',
  },
});
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { Client } = require('pg');
const { DatabaseSync } = require('node:sqlite');
const { createDataSource } = require('../dist/platform/database/data-source');
const { createHttpApplication } = require('../dist/bootstrap/application');
const { readConfig } = require('../dist/bootstrap/config');
const {
  ScryptPasswords,
  OpaqueTokens,
} = require('../dist/bounded-contexts/identity/infrastructure/crypto');
const {
  NodeSdmCryptography,
  sdmMessage,
} = require('../dist/bounded-contexts/traceability/infrastructure/sdm-crypto');
const { syntheticSdmReading } = require('../test/sdm-fixtures');
const { OutboxDispatcher } = require('../dist/platform/messaging/outbox-dispatcher');
const { AuditConsumer } = require('../dist/platform/audit/audit-consumer');
const { ReconciliationConsumer } = require('../dist/platform/messaging/reconciliation-consumer');
const {
  ReconcileObservations,
} = require('../dist/bounded-contexts/traceability/application/reconcile-observations');
const {
  NodeIds,
  SystemClock,
  NodeMonotonicClock,
  Sha256Fingerprint,
} = require('../dist/platform/runtime');
const { datasetCsv } = require('../dist/bounded-contexts/experimentation/domain/csv');
const mobile = path.resolve(process.env.MOBILE_REPO ?? '../Nova-tag-expo');
const { SqliteCaptureStore } = require(path.join(mobile, 'src/infra/offline/sqlite-store.ts'));
function connection(db) {
  let tail = Promise.resolve();
  const port = {
    exec: async (s) => db.exec(s),
    run: async (s, p = []) => ({ changes: Number(db.prepare(s).run(...p).changes) }),
    first: async (s, p = []) => db.prepare(s).get(...p) ?? null,
    all: async (s, p = []) => db.prepare(s).all(...p),
    transaction: (work) => {
      const task = tail.then(async () => {
        db.exec('BEGIN IMMEDIATE');
        try {
          const value = await work(port);
          db.exec('COMMIT');
          return value;
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      });
      tail = task.catch(() => {});
      return task;
    },
  };
  return port;
}
async function main() {
  const databaseUrl =
    process.env.EXPERIMENT_TEST_DATABASE_URL ??
    'postgresql://nfc_trace:nfc_trace_local@127.0.0.1:55432/nfc_trace_experiment_scenarios_test';
  const url = new URL(databaseUrl),
    database = url.pathname.slice(1);
  if (
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    !/^[a-z][a-z0-9_]*_test$/.test(database)
  )
    throw Error('A dedicated local _test database is required');
  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const adminDb = new Client({ connectionString: adminUrl.toString() });
  await adminDb.connect();
  try {
    if (!(await adminDb.query('SELECT 1 FROM pg_database WHERE datname=$1', [database])).rowCount)
      await adminDb.query('CREATE DATABASE "' + database + '"');
  } finally {
    await adminDb.end();
  }
  const source = await createDataSource(databaseUrl).initialize();
  let app, sqlite;
  const directory = path.resolve(
    process.env.EXPERIMENT_OUTPUT ?? '.tmp/experiment-scenarios-' + randomUUID(),
  );
  fs.mkdirSync(directory, { recursive: false });
  try {
    await source.runMigrations({ transaction: 'all' });
    const identities = {};
    const tokens = new OpaqueTokens();
    const fixturePassword = randomBytes(24).toString('hex');
    const hash = await new ScryptPasswords().hash(fixturePassword);
    for (const role of ['ADMINISTRADOR', 'OPERADOR']) {
      const id = randomUUID(),
        token = tokens.issue();
      await source.query(
        'INSERT INTO identity_accounts(id,login,name,role,password_hash) VALUES($1,$2,$3,$4,$5)',
        [id, 'fixture-' + id, 'Synthetic scenario client', role, hash],
      );
      await source.query(
        "INSERT INTO identity_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')",
        [randomUUID(), id, tokens.digest(token)],
      );
      identities[role] = { id, token };
    }
    const masters = JSON.stringify({ 1: randomBytes(32).toString('base64') });
    const vault = new NodeSdmCryptography('1', masters);
    app = await createHttpApplication(
      readConfig({
        DATABASE_URL: databaseUrl,
        APP_PROCESS_ROLE: 'api',
        SDM_ACTIVE_MASTER_VERSION: '1',
        SDM_MASTER_KEYS_JSON: masters,
      }),
      source,
      false,
      true,
    );
    await app.listen(0, '127.0.0.1');
    const base = 'http://127.0.0.1:' + app.getHttpServer().address().port + '/api/v1';
    async function http(route, body, role = 'ADMINISTRADOR', expected = body ? 201 : 200) {
      const response = await fetch(base + route, {
        method: body ? 'POST' : 'GET',
        headers: {
          Authorization: 'Bearer ' + identities[role].token,
          'Content-Type': 'application/json',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(20000),
      });
      const result = await response.json();
      assert.equal(response.status, expected, result.codigo);
      return result.dados;
    }
    const gitVersion = (repo) =>
      require('node:child_process')
        .execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' })
        .trim() + '+working-tree';
    const run = {
      id: randomUUID(),
      name: 'Synthetic scenario controls v1',
      dataKind: 'SINTETICO',
      protocolVersion: 'instrumentation.v1',
      apiVersion: gitVersion(path.resolve('.')),
      mobileVersion: gitVersion(mobile),
      configuration: {
        tagModel: 'SYNTHETIC-NO-HARDWARE',
        antenna: 'not measured',
        position: 'not measured',
        surface: 'not measured',
        phoneCase: 'not measured',
        timeoutMs: 1000,
      },
    };
    await http('/experimentos', run);
    const sessionId = randomUUID(),
      clockId = randomUUID();
    let ordinal = 0;
    sqlite = new DatabaseSync(path.join(directory, 'queue.sqlite'));
    let sql = connection(sqlite),
      store = new SqliteCaptureStore(async () => sql);
    await store.initialize();
    const owner = { baseUrl: base, userId: identities.OPERADOR.id };
    const outcomes = [];
    const dispatcher = () =>
      new OutboxDispatcher(
        source,
        [
          new AuditConsumer(),
          new ReconciliationConsumer(
            new ReconcileObservations(new SystemClock(), new NodeIds(), new NodeMonotonicClock()),
          ),
        ],
        { batchSize: 100, leaseMs: 30000 },
      );
    async function drain() {
      for (let i = 0; i < 15; i++) {
        const progress = await dispatcher().tick();
        if (progress === 0) break;
      }
    }
    async function link(strategy, policy = 'ESTRITA') {
      const uid = '04' + randomBytes(6).toString('hex').toUpperCase();
      const order = await http('/pedidos', { codigo: 'EXP-' + randomUUID() });
      const p = await http('/etiquetas', {
        pedidoId: order.id,
        uid,
        modelo: 'SYNTHETIC-NO-HARDWARE',
        estrategia: strategy,
        ...(strategy === 'SDM' ? { politicaSdm: policy } : {}),
      });
      const secrets =
        strategy === 'SDM'
          ? (
              await source.query(
                'SELECT p.sdm,k.sealed FROM provisionings p JOIN sdm_keys k ON k.provisioning_id=p.id WHERE p.id=$1',
                [p.id],
              )
            )[0]
          : null;
      const reading = (counter) =>
        secrets
          ? syntheticSdmReading(vault, p.id, secrets.sdm, secrets.sealed, uid, counter)
          : { uid, ...(p.referenciaNdef ? { ndef: p.referenciaNdef } : {}) };
      const active = await http(
        '/provisionamentos/' + p.id + '/ativacao',
        {
          bloqueioConfirmado: true,
          ...(strategy === 'SDM'
            ? { leituraSdm: reading(1) }
            : p.referenciaNdef
              ? { referenciaNdef: p.referenciaNdef }
              : {}),
        },
        'ADMINISTRADOR',
        200,
      );
      return { p: active, reading, strategy, policy: strategy === 'SDM' ? policy : null };
    }
    async function prepare(
      l,
      scenario,
      type = 'COLETA',
      legitimate = true,
      raw = l.reading(2),
      changedContext = {},
    ) {
      const trial = {
        id: randomUUID(),
        sessionId,
        tagLabel: 'TAG-' + ++ordinal,
        boxLabel: 'BOX-' + ordinal,
        deviceId: 'synthetic-client',
        deviceModel: 'no physical phone',
        osVersion: 'Node.js fixture',
        provisioningId: l.p.id,
        treatment: l.strategy,
        policy: l.policy,
        scenario,
        mode: 'SINTETICA',
        ordinal,
        eventType: type,
      };
      await http('/experimentos/' + run.id + '/tentativas', trial);
      await http('/experimentos/tentativas/' + trial.id + '/observacao-independente', {
        id: randomUUID(),
        legitimate,
        shouldAuthorize: legitimate,
        observedBox: legitimate ? trial.boxLabel : 'ADVERSE-BOX',
        observedTag: trial.tagLabel,
        observedOrdinal: trial.ordinal,
        observedAt: '2026-10-07T12:00:00Z',
        source: 'ROTEIRO_SINTETICO',
        excluded: false,
        exclusionReason: 'NAO_EXCLUIDA',
      });
      const attemptId = randomUUID(),
        input = {
          id: randomUUID(),
          versaoContrato: 1,
          provisionamentoId: l.p.id,
          tipo: type,
          ocorridoEm: '2026-10-07T12:00:00Z',
          dispositivoId: trial.deviceId,
          operadorId: owner.userId,
          leituraBruta: raw,
          ...changedContext,
        };
      const record = async (
        stage,
        observationId = null,
        durationMs = null,
        boundary = 'INSTANTE',
        code = null,
      ) =>
        http(
          '/experimentos/registros',
          {
            id: randomUUID(),
            trialId: trial.id,
            attemptId,
            stage,
            observationId,
            deviceId: trial.deviceId,
            occurredAt: '2026-10-07T12:00:00Z',
            clockId,
            monotonicMs: performance.now(),
            durationMs,
            boundary,
            code,
          },
          'OPERADOR',
          200,
        );
      await record('TENTATIVA_INICIADA');
      await record('LEITURA_OK', null, null, 'SESSAO_NFC_ATE_EVIDENCIA'); // No fabricated RF latency.
      await store.enqueue(owner, input, { provisioning: l.p, cacheUsed: true }, Date.now());
      await record('CAPTURA_LOCAL', input.id);
      async function send(body = input, lost = false) {
        await record('ENVIO_INICIADO', input.id);
        const start = performance.now();
        const answer = await http('/eventos', body, 'OPERADOR', 200);
        await record(
          lost ? 'ENVIO_FALHOU' : 'ENVIO_CONFIRMADO',
          input.id,
          performance.now() - start,
          'ENVIO_ATE_RESPOSTA',
          lost ? 'RESPOSTA_PERDIDA' : 'OK',
        );
        return answer;
      }
      return { trial, input, record, send };
    }
    async function assertDecision(c, answer, expectation) {
      for (const [key, value] of Object.entries(expectation))
        assert.equal(answer.decisao[key], value, c.trial.scenario + ' ' + key);
      outcomes.push({
        trialId: c.trial.id,
        observationId: c.input.id,
        scenario: c.trial.scenario,
        treatment: c.trial.treatment,
        policy: c.trial.policy,
        expected: expectation,
        actual: answer.decisao,
        source: 'SINTETICO',
        physical: false,
      });
    }
    for (const strategy of ['UID', 'NDEF_ESTATICO', 'SDM']) {
      let l = await link(strategy),
        c = await prepare(l, 'LEGITIMO_ONLINE');
      await assertDecision(c, await c.send(), { autorizada: true });
      l = await link(strategy);
      c = await prepare(l, 'DUPLICACAO');
      const first = await c.send();
      assert.deepEqual(await c.send(), first);
      await assertDecision(c, first, { autorizada: true });
      assert.equal(
        (
          await source.query('SELECT COUNT(*) FROM movements WHERE observation_id=$1', [c.input.id])
        )[0].count,
        '1',
      );
      l = await link(strategy);
      c = await prepare(l, 'RESPOSTA_PERDIDA');
      const committed = await c.send(c.input, true);
      assert.deepEqual(await c.send(), committed);
      await assertDecision(c, committed, { autorizada: true });
      l = await link(strategy);
      c = await prepare(l, 'CONCORRENCIA');
      const raced = await Promise.all(Array.from({ length: 5 }, () => c.send()));
      raced.forEach((r) => assert.deepEqual(r, raced[0]));
      await assertDecision(c, raced[0], { autorizada: true });
      l = await link(strategy);
      c = await prepare(l, 'LEGITIMO_OFFLINE');
      sqlite.close();
      sqlite = new DatabaseSync(path.join(directory, 'queue.sqlite'));
      sql = connection(sqlite);
      store = new SqliteCaptureStore(async () => sql);
      assert.deepEqual((await store.get(owner, c.input.id)).payload, c.input);
      await c.record('COMUNICACAO_LIBERADA', c.input.id);
      await assertDecision(c, await c.send(), { autorizada: true });
      l = await link(strategy);
      c = await prepare(l, 'UID_DIVERGENTE', 'COLETA', false, {
        ...l.reading(2),
        uid: '00112233445566',
      });
      await assertDecision(c, await c.send(), {
        autorizada: strategy !== 'UID',
        classificacao: 'SUSPEITO',
      });
      l = await link(strategy);
      const raw = l.reading(2),
        bytes = raw.bytesBase64
          ? Buffer.from(raw.bytesBase64, 'base64')
          : Buffer.from([0xd1, 1, 2, 0x55, 0, 0x61]);
      bytes[bytes.length - 1] ^= 1;
      c = await prepare(l, 'BYTES_ALTERADOS', 'COLETA', false, {
        ...raw,
        bytesBase64: bytes.toString('base64'),
      });
      await assertDecision(c, await c.send(), { autorizada: strategy !== 'SDM' });
      l = await link(strategy);
      c = await prepare(l, 'CONTEXTO_ALTERADO', 'COLETA', false, l.reading(2), {
        ocorridoEm: '2035-01-01T00:00:00Z',
      });
      // Raw evidence does not authenticate event/time/operator/location; UUID snapshot is frozen in SQLite.
      await assertDecision(c, await c.send(), { autorizada: true });
      l = await link(strategy);
      c = await prepare(l, 'REORDENACAO', 'ENTREGA', true, l.reading(2));
      const pending = await c.send();
      assert.equal(pending.decisao.status, 'PENDENTE');
      for (const [type, counter] of [
        ['COLETA', 3],
        ['RECEBIMENTO', 4],
      ]) {
        const earlier = await prepare(l, 'REORDENACAO', type, true, l.reading(counter));
        await earlier.send();
      }
      await drain();
      const current = await http('/eventos/' + c.input.id, undefined, 'OPERADOR');
      assert.equal(current.historicoDecisoes.length, 2);
      assert.deepEqual(await c.send(), pending);
      await assertDecision(c, current, { autorizada: true });
      l = await link(strategy);
      c = await prepare(l, 'TRANSFERENCIA_ETIQUETA', 'COLETA', false);
      await assertDecision(c, await c.send(), { autorizada: true }); // Visual reassociation is independent ground truth, not a real transfer.
      if (strategy === 'NDEF_ESTATICO') {
        l = await link(strategy);
        c = await prepare(l, 'NDEF_COPIADO', 'COLETA', false, {
          ...l.reading(2),
          uid: '00112233445566',
        });
        await assertDecision(c, await c.send(), { autorizada: true, classificacao: 'SUSPEITO' });
      }
      if (strategy === 'SDM') {
        l = await link(strategy);
        const evidence = l.reading(2);
        const initial = await prepare(l, 'LEGITIMO_ONLINE', 'COLETA', true, evidence);
        await initial.send();
        c = await prepare(l, 'SDM_REUTILIZADO', 'RECEBIMENTO', false, evidence);
        await assertDecision(c, await c.send(), {
          autorizada: false,
          motivo: 'SDM_EVIDENCIA_REUTILIZADA',
        });
        for (const policy of ['ESTRITA', 'REGISTRO_TARDIO']) {
          l = await link(strategy, policy);
          const ahead = await prepare(l, 'LEGITIMO_ONLINE', 'COLETA', true, l.reading(10));
          await ahead.send();
          c = await prepare(l, 'PRIMEIRA_APRESENTACAO_TARDIA', 'RECEBIMENTO', true, l.reading(5));
          const late = await c.send();
          assert.equal(late.decisao.sdm.previamenteUtilizada, false);
          await assertDecision(c, late, {
            autorizada: false,
            status: 'TARDIA',
            motivo: policy === 'ESTRITA' ? 'SDM_CONTADOR_NAO_CRESCENTE' : 'SDM_REGISTRO_TARDIO',
          });
        }
      }
    }
    const bundle = await http('/experimentos/' + run.id + '/exportacao');
    assert.ok(
      bundle.dataset.serverMeasurements.some(
        (m) => m.boundary === 'RECONCILIACAO_ANTES_COMMIT' && m.revision === 2,
      ),
    );
    assert.equal(bundle.integrity.errors.length, 0, JSON.stringify(bundle.integrity));
    assert.equal(bundle.checksum, new Sha256Fingerprint().of(bundle.dataset));
    fs.writeFileSync(path.join(directory, 'dataset.json'), JSON.stringify(bundle, null, 2));
    const last = outcomes.at(-1);
    const frozen = await store.get(owner, last.observationId);
    const replayFixture = path.join(directory, 'replay-fixture.json');
    fs.writeFileSync(
      replayFixture,
      JSON.stringify(
        {
          schemaVersion: 1,
          runId: run.id,
          steps: [
            {
              trialId: last.trialId,
              body: frozen.payload,
              expect: {
                httpStatus: 200,
                authorized: last.actual.autorizada,
                reason: last.actual.motivo,
              },
              repeat: 2,
            },
          ],
        },
        null,
        2,
      ),
    );
    const { execFileSync } = require('node:child_process');
    await new Promise((resolve, reject) => {
      const child = require('node:child_process').spawn(
        process.execPath,
        ['scripts/experiment-replay.cjs', replayFixture, path.join(directory, 'replay')],
        {
          env: {
            ...process.env,
            EXPERIMENT_API_URL: base,
            EXPERIMENT_LOGIN: 'fixture-' + identities.OPERADOR.id,
            EXPERIMENT_PASSWORD: fixturePassword,
          },
          stdio: ['ignore', 'ignore', 'ignore'],
          windowsHide: true,
        },
      );
      child.once('error', () => reject(Error('Replay CLI could not start')));
      child.once('exit', (code) =>
        code === 0 ? resolve() : reject(Error('Replay CLI failed: ' + code)),
      );
    });
    execFileSync(
      process.execPath,
      ['scripts/experiment-data.cjs', 'validate', path.join(directory, 'dataset.json')],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    execFileSync(
      process.execPath,
      [
        'scripts/experiment-data.cjs',
        'csv',
        path.join(directory, 'dataset.json'),
        path.join(directory, 'converted'),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    for (const [name, csv] of Object.entries(datasetCsv(bundle.dataset)))
      fs.writeFileSync(path.join(directory, name), csv);
    fs.writeFileSync(
      path.join(directory, 'scenario-results.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          runId: run.id,
          dataKind: 'SINTETICO',
          outcomes,
          physicalPending: [
            'NFC session/read success timings',
            'real copied/transferred tags',
            'actual 424 personalization/protection/recovery',
            'main comparative cohort',
          ],
          integrity: bundle.integrity,
        },
        null,
        2,
      ),
    );
    process.stdout.write(
      JSON.stringify({
        runId: run.id,
        cases: outcomes.length,
        trials: bundle.dataset.trials.length,
        output: directory,
        integrity: bundle.integrity.status,
        dataKind: 'SINTETICO',
      }) + '\n',
    );
  } finally {
    sqlite?.close();
    await app?.close();
    if (source.isInitialized) await source.destroy();
  }
}
main().catch((e) => {
  process.stderr.write(
    'Synthetic scenario assertion failed: ' + String(e.message).slice(0, 300) + '\n',
  );
  process.exitCode = 1;
});
