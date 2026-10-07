// Explicit synthetic acceptance against the mobile queue, real SQLite, HTTP and PostgreSQL.
// Requires both checkouts. Never run automatically in production or in GitHub Actions.
require('reflect-metadata');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { Client } = require('pg');
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
const mobile = path.resolve(process.env.MOBILE_REPO ?? '../Nova-tag-expo');
const { SqliteCaptureStore } = require(path.join(mobile, 'src/infra/offline/sqlite-store.ts'));
const { OfflineCoordinator } = require(
  path.join(mobile, 'src/appplication/offline/coordinator.ts'),
);
const { syntheticSdmReading } = require('../test/sdm-fixtures.ts');
const { createDataSource } = require('../dist/platform/database/data-source');
const { createHttpApplication } = require('../dist/bootstrap/application');
const { readConfig } = require('../dist/bootstrap/config');
const {
  ScryptPasswords,
  OpaqueTokens,
} = require('../dist/bounded-contexts/identity/infrastructure/crypto');
const {
  NodeSdmCryptography,
} = require('../dist/bounded-contexts/traceability/infrastructure/sdm-crypto');
const {
  ReconcileObservations,
} = require('../dist/bounded-contexts/traceability/application/reconcile-observations');
const { ReconciliationConsumer } = require('../dist/platform/messaging/reconciliation-consumer');
const { OutboxDispatcher } = require('../dist/platform/messaging/outbox-dispatcher');
const { AuditConsumer } = require('../dist/platform/audit/audit-consumer');
const { NodeIds, SystemClock } = require('../dist/platform/runtime');

function connection(db) {
  let tail = Promise.resolve();
  const port = {
    exec: async (sql) => {
      db.exec(sql);
    },
    run: async (sql, params = []) => ({ changes: Number(db.prepare(sql).run(...params).changes) }),
    first: async (sql, params = []) => db.prepare(sql).get(...params) ?? null,
    all: async (sql, params = []) => db.prepare(sql).all(...params),
    transaction(work) {
      const next = tail.then(async () => {
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
      tail = next.catch(() => {});
      return next;
    },
  };
  return port;
}
async function main() {
  const databaseUrl =
    process.env.RECONCILIATION_TEST_DATABASE_URL ??
    'postgresql://nfc_trace:nfc_trace_local@127.0.0.1:55432/nfc_trace_reconciliation_queue_test';
  const url = new URL(databaseUrl);
  const database = url.pathname.slice(1);
  if (
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    !/^[a-z][a-z0-9_]*_test$/.test(database)
  )
    throw new Error('Use only a local dedicated _test database');
  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [database])).rowCount)
      await admin.query('CREATE DATABASE "' + database + '"');
  } finally {
    await admin.end();
  }
  const source = await createDataSource(databaseUrl).initialize();
  let app;
  let sqlite;
  const folder = path.resolve('.tmp/reconciliation-acceptance');
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, randomUUID() + '.sqlite');
  try {
    await source.runMigrations({ transaction: 'all' });
    const userId = randomUUID();
    const token = new OpaqueTokens().issue();
    await source.query(
      'INSERT INTO identity_accounts(id,login,name,role,password_hash) VALUES ($1,$2,$3,$4,$5)',
      [
        userId,
        'rec.' + randomUUID(),
        'Synthetic queue acceptance',
        'ADMINISTRADOR',
        await new ScryptPasswords().hash(randomBytes(24).toString('hex')),
      ],
    );
    await source.query(
      "INSERT INTO identity_sessions(id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,clock_timestamp()+interval '1 hour')",
      [randomUUID(), userId, new OpaqueTokens().digest(token)],
    );
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
    const baseUrl = 'http://127.0.0.1:' + app.getHttpServer().address().port + '/api/v1';
    const owner = { baseUrl, userId };
    const api = {
      async request(route, options = {}) {
        if (options.expectedUserId) assert.equal(options.expectedUserId, userId);
        if (options.expectedBaseUrl) assert.equal(options.expectedBaseUrl, baseUrl);
        const response = await fetch(baseUrl + route, {
          method: options.method ?? 'GET',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        });
        const result = await response.json();
        if (!response.ok || !result.sucesso)
          throw new Error('HTTP ' + response.status + ' ' + result.codigo);
        return result.dados;
      },
    };
    sqlite = new DatabaseSync(file);
    let sql = connection(sqlite);
    let store = new SqliteCaptureStore(async () => sql);
    const createCoordinator = () =>
      new OfflineCoordinator(
        store,
        () => ({ ...owner, canCapture: true, canSend: true }),
        api,
        () => {
          throw new Error('Unnecessary NFC lookup');
        },
        randomUUID,
        Date.now,
      );
    const outcomes = [];
    for (const strategy of ['UID', 'NDEF_ESTATICO', 'SDM']) {
      const uid = '04' + randomBytes(6).toString('hex').toUpperCase();
      const order = await api.request('/pedidos', {
        method: 'POST',
        body: { codigo: 'QUEUE-' + randomUUID() },
      });
      const p = await api.request('/etiquetas', {
        method: 'POST',
        body: {
          pedidoId: order.id,
          uid,
          modelo: 'SYNTHETIC-NO-HARDWARE',
          estrategia: strategy,
          ...(strategy === 'SDM' ? { politicaSdm: 'ESTRITA' } : {}),
        },
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
      const active = await api.request('/provisionamentos/' + p.id + '/ativacao', {
        method: 'POST',
        body: {
          bloqueioConfirmado: true,
          ...(strategy === 'SDM'
            ? { leituraSdm: reading(1) }
            : p.referenciaNdef
              ? { referenciaNdef: p.referenciaNdef }
              : {}),
        },
      });
      const ids = [];
      let counter = 1;
      for (const tipo of ['ENTREGA', 'COLETA', 'RECEBIMENTO']) {
        const input = {
          id: randomUUID(),
          versaoContrato: 1,
          provisionamentoId: p.id,
          tipo,
          ocorridoEm: '2026-10-07T12:00:00.000Z',
          dispositivoId: 'synthetic-sqlite',
          leituraBruta: reading(++counter),
        };
        await store.enqueue(owner, input, { provisioning: active, cacheUsed: true }, Date.now());
        ids.push(input.id);
      }
      sqlite.close();
      sqlite = new DatabaseSync(file);
      sql = connection(sqlite);
      store = new SqliteCaptureStore(async () => sql);
      const coordinator = createCoordinator();
      await coordinator.synchronize();
      const pending = await store.get(owner, ids[0]);
      assert.equal(pending.state, 'STORED');
      assert.equal(pending.businessState, 'PENDING');
      const worker = () =>
        new OutboxDispatcher(
          source,
          [
            new AuditConsumer(),
            new ReconciliationConsumer(new ReconcileObservations(new SystemClock(), new NodeIds())),
          ],
          { batchSize: 100, leaseMs: 30000 },
        );
      for (let i = 0; i < 20; i++) {
        if (!(await worker().tick())) break;
      }
      await coordinator.refreshDecisions();
      const current = await store.get(owner, ids[0]);
      assert.equal(current.businessState, 'ACCEPTED');
      assert.deepEqual(current.receipt, pending.receipt);
      assert.deepEqual(current.payload, pending.payload);
      assert.equal(current.currentDecision.decisao.status, 'AUTORIZADA');
      assert.ok(current.currentDecision.historicoDecisoes.length >= 2);
      assert.deepEqual(
        await api.request('/eventos', { method: 'POST', body: current.payload }),
        pending.receipt,
      );
      assert.equal((await api.request('/pedidos/' + order.id)).estado, 'ENTREGUE');
      assert.equal(
        (await source.query('SELECT count(*) FROM movements WHERE observation_id=$1', [ids[0]]))[0]
          .count,
        '1',
      );
      if (strategy === 'SDM') {
        assert.deepEqual(current.currentDecision.decisao.sdm, pending.receipt.decisao.sdm);
        assert.equal(
          (
            await source.query('SELECT maximum FROM sdm_counter_state WHERE provisioning_id=$1', [
              p.id,
            ])
          )[0].maximum,
          4,
        );
      }
      sqlite.close();
      sqlite = new DatabaseSync(file);
      sql = connection(sqlite);
      store = new SqliteCaptureStore(async () => sql);
      assert.deepEqual(await store.get(owner, ids[0]), current);
      outcomes.push({
        strategy,
        captures: 3,
        current: 'AUTORIZADA',
        receipt: 'PENDENTE',
        sqliteRestart: true,
        duplicateMovements: 0,
      });
    }
    console.log(
      JSON.stringify({
        synthetic: true,
        hardwareAcceptance: false,
        http: true,
        postgresql: true,
        sqlite: true,
        outcomes,
      }),
    );
  } finally {
    sqlite?.close();
    await app?.close();
    await source.destroy();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
