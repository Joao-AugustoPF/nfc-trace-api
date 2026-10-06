// Explicit synthetic/native acceptance fixture. Never started by the application.
require('reflect-metadata');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { createHttpApplication } = require('../dist/bootstrap/application');
const { readConfig } = require('../dist/bootstrap/config');
const { createDataSource } = require('../dist/platform/database/data-source');
const { ScryptPasswords } = require('../dist/bounded-contexts/identity/infrastructure/crypto');
const {
  TypeOrmUnitOfWork,
} = require('../dist/bounded-contexts/traceability/infrastructure/typeorm-unit-of-work');
const { CreateOrder } = require('../dist/bounded-contexts/traceability/application/create-order');
const { ProvisionTag } = require('../dist/bounded-contexts/traceability/application/provision-tag');
const {
  ActivateProvisioning,
} = require('../dist/bounded-contexts/traceability/application/change-provisioning');
const { NodeIds, SystemClock } = require('../dist/platform/runtime');

(async () => {
  const file = process.env.OFFLINE_ACCEPTANCE_FILE;
  if (!file)
    throw new Error('Defina OFFLINE_ACCEPTANCE_FILE fora do Git para as contas temporárias.');
  const databaseUrl =
    process.env.OFFLINE_TEST_DATABASE_URL ??
    'postgresql://nfc_trace:nfc_trace_local@127.0.0.1:55432/nfc_trace_offline_acceptance_test';
  const url = new URL(databaseUrl);
  const database = url.pathname.slice(1);
  if (
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    !/^[a-z][a-z0-9_]*_test$/.test(database)
  ) {
    throw new Error('Aceite permitido somente em PostgreSQL local com banco terminado em _test.');
  }
  const administrative = new URL(url);
  administrative.pathname = '/postgres';
  const admin = new Client({ connectionString: administrative.toString() });
  await admin.connect();
  if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [database])).rowCount) {
    await admin.query('CREATE DATABASE "' + database + '"');
  }
  await admin.end();
  const source = await createDataSource(databaseUrl).initialize();
  await source.runMigrations({ transaction: 'all' });
  const password = randomBytes(24).toString('hex');
  const hash = await new ScryptPasswords().hash(password);
  const users = [];
  for (const role of ['ADMINISTRADOR', 'OPERADOR', 'CONSULTA']) {
    const user = {
      id: randomUUID(),
      login: 'offline.' + role.toLowerCase() + '.' + Date.now(),
      password,
      role,
    };
    await source.query(
      'INSERT INTO identity_accounts(id,login,name,role,password_hash) VALUES($1,$2,$3,$4,$5)',
      [user.id, user.login, 'Aceite sintético ' + role, role, hash],
    );
    users.push(user);
  }
  const uow = new TypeOrmUnitOfWork(source);
  const clock = new SystemClock();
  const ids = new NodeIds();
  const tags = [];
  for (const strategy of ['UID', 'NDEF_ESTATICO']) {
    const uid = '04' + randomBytes(6).toString('hex').toUpperCase();
    const order = await new CreateOrder(uow, clock, ids).execute(
      { codigo: 'OFFLINE-' + randomUUID() },
      'native-offline-fixture',
    );
    const p = await new ProvisionTag(uow, clock, ids).execute(
      { pedidoId: order.id, uid, modelo: 'FIXTURE_SINTETICA', estrategia: strategy },
      'native-offline-fixture',
    );
    await new ActivateProvisioning(uow, clock, ids).execute(
      p.id,
      {
        bloqueioConfirmado: true,
        ...(p.referenciaNdef ? { referenciaNdef: p.referenciaNdef } : {}),
      },
      'native-offline-fixture',
    );
    tags.push({ uid, reference: p.referenciaNdef });
  }
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    JSON.stringify({ synthetic: true, baseUrl: 'http://127.0.0.1:3114/api/v1', users, tags }),
  );
  const app = await createHttpApplication(
    readConfig({
      DATABASE_URL: databaseUrl,
      APP_PROCESS_ROLE: 'api',
      PORT: '3114',
      HOST: '127.0.0.1',
    }),
    source,
    true,
    true,
  );
  await app.listen(3114, '127.0.0.1');
  console.log(
    JSON.stringify({ event: 'offline_acceptance_ready', port: 3114, database, synthetic: true }),
  );
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
