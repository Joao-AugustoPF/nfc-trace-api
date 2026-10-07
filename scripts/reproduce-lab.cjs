// Isolated real production image/PostgreSQL rehearsal, never the active lab project.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const { spawnSync, spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { identity } = require('./source-identity.cjs');
const { backup, restore, postgres } = require('./lab-backup.cjs');
const root = path.resolve(__dirname, '..');
const project = 'nfc-repro-' + randomUUID().slice(0, 8);
const folder = path.join(root, '.tmp', project);
fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
fs.mkdirSync(folder, { recursive: false });
const env = {
  ...process.env,
  REPRO_DB_PASSWORD: randomBytes(24).toString('hex'),
  REPRO_REVISION: identity(root, 'api').revision || '',
};
// Existing .env is not read by compose. No lab secrets enter the rehearsal.
const empty = path.join(folder, 'compose.env');
fs.writeFileSync(empty, '');
const compose = [
  'compose',
  '--env-file',
  empty,
  '-p',
  project,
  '-f',
  path.join(root, 'infra/compose.reproduction.yaml'),
];
function docker(args, input) {
  const r = spawnSync('docker', [...compose, ...args], {
    env,
    input,
    maxBuffer: 32 * 1024 * 1024,
    shell: false,
  });
  if (r.status !== 0)
    throw Error('Reproduction Docker command failed; inspect project ' + project + '.');
  return r.stdout.toString().trim();
}
async function build() {
  const child = spawn(
    'docker',
    [...compose, 'up', '-d', '--build', '--wait', '--wait-timeout', '180', 'api'],
    { env, shell: false },
  );
  const log = fs.createWriteStream(path.join(folder, 'build.log'), { flags: 'wx' });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  const timer = setInterval(
    () => process.stdout.write('Isolated Docker build/start remains active: ' + project + '\n'),
    30000,
  );
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    if (code !== 0) throw Error('Isolated build/start failed. See private reproduction folder.');
  } finally {
    clearInterval(timer);
    log.end();
  }
}
async function main() {
  process.stdout.write(
    'Starting isolated local reproduction ' + project + '; no main/CI/EAS actions.\n',
  );
  await build();
  const container = docker(['ps', '-q', 'postgres']);
  const pg = postgres(container);
  let url = 'http://' + docker(['port', 'api', '3000']);
  const password = randomBytes(24).toString('base64url') + '!aA9';
  env.AUTH_BOOTSTRAP_PASSWORD = password;
  docker([
    'exec',
    '-T',
    '-e',
    'AUTH_BOOTSTRAP_LOGIN=reproduction-admin',
    '-e',
    'AUTH_BOOTSTRAP_NAME=Reproduction',
    '-e',
    'AUTH_BOOTSTRAP_PASSWORD',
    'api',
    'node',
    'dist/platform/access/bootstrap-cli.js',
  ]);
  docker(['exec', '-T', 'api', 'node', 'dist/platform/database/cli.js', 'seed']);
  docker(['exec', '-T', 'api', 'node', 'dist/platform/database/cli.js', 'seed']);
  assert.equal(
    pg.sql('nfc_reproduction_test', "SELECT count(*) FROM orders WHERE code LIKE 'TCC-%'"),
    '3',
  );
  let token;
  async function call(route, body) {
    const response = await fetch(url + '/api/v1' + route, {
      method: body ? 'POST' : 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20000),
    });
    const value = await response.json();
    assert.equal(response.ok, true, 'HTTP route ' + route + ' failed');
    return value.dados;
  }
  token = (await call('/autenticacao/login', { login: 'reproduction-admin', senha: password }))
    .tokenAcesso;
  const counts = [];
  const replayProofs = [];
  for (const strategy of ['UID', 'NDEF_ESTATICO']) {
    const order = await call('/pedidos', {
      codigo: 'REPRO-' + strategy,
      descricao: 'SYNTHETIC HTTP; NO NFC HARDWARE',
    });
    const link = await call('/etiquetas', {
      pedidoId: order.id,
      uid: randomBytes(7).toString('hex').toUpperCase(),
      modelo: 'SYNTHETIC-REPRODUCTION',
      estrategia: strategy,
    });
    const activation = {
      bloqueioConfirmado: true,
      ...(strategy === 'NDEF_ESTATICO' ? { referenciaNdef: link.referenciaNdef } : {}),
    };
    await call('/provisionamentos/' + link.id + '/ativacao', activation);
    await call('/provisionamentos/' + link.id + '/ativacao', activation);
    for (const tipo of ['COLETA', 'MOVIMENTACAO', 'RECEBIMENTO', 'EXPEDICAO', 'ENTREGA']) {
      const input = {
        id: randomUUID(),
        versaoContrato: 1,
        provisionamentoId: link.id,
        tipo,
        ocorridoEm: new Date().toISOString(),
        dispositivoId: 'reproduction-http',
        leituraBruta: {
          uid: link.uid,
          ...(strategy === 'NDEF_ESTATICO' ? { ndef: link.referenciaNdef } : {}),
        },
      };
      const result = await call('/eventos', input);
      assert.equal(result.decisao.autorizada, true);
      assert.deepEqual(await call('/eventos', input), result);
      replayProofs.push({ input, result });
    }
    assert.equal((await call('/pedidos/' + order.id)).estado, 'ENTREGUE');
    counts.push({ strategy, orderId: order.id });
  }
  const response = await fetch(url + '/health/version');
  const runtime = await response.json();
  assert.equal(runtime.status, 'BUILD_IDENTIFICADO');
  assert.equal(runtime.sourceSha256, identity(root, 'api').sourceSha256);
  const migrations = pg.sql('nfc_reproduction_test', 'SELECT count(*) FROM migrations');
  assert.equal(migrations, '5');
  await call('/autenticacao/logout', {});
  // Stop every writer (api only role; no events process was started).
  docker(['stop', 'api']);
  const saved = backup(container, 'nfc_reproduction_test', path.join(folder, 'backup'));
  const recovered = restore(container, 'nfc_restore_test', path.join(folder, 'backup'));
  const sequenceSql = "SELECT last_value::text || '/' || is_called::text FROM migrations_id_seq";
  assert.equal(
    pg.sql('nfc_reproduction_test', sequenceSql),
    pg.sql('nfc_restore_test', sequenceSql),
  );
  assert.throws(() =>
    pg.sql('nfc_restore_test', "UPDATE observations SET fingerprint=repeat('0',64)"),
  );
  assert.equal(pg.sql('nfc_restore_test', 'SELECT count(*) FROM observations'), '10');
  assert.equal(pg.sql('nfc_restore_test', 'SELECT count(*) FROM movements'), '12');
  assert.equal(
    pg.sql('nfc_restore_test', "SELECT count(*) FROM outbox WHERE status='PENDING'") !== '0',
    true,
  );
  // Run migrated/seeded production image against restored DB; execute the real dispatcher once.
  env.DATABASE_URL =
    'postgresql://reproduction:' + env.REPRO_DB_PASSWORD + '@postgres:5432/nfc_restore_test';
  const restoredApi = docker([
    'run',
    '-d',
    '--rm',
    '--no-deps',
    '--service-ports',
    '-e',
    'DATABASE_URL',
    'api',
  ]);
  const mapped = spawnSync('docker', ['port', restoredApi, '3000'], {
    encoding: 'utf8',
    shell: false,
  });
  assert.equal(mapped.status, 0);
  url = 'http://' + mapped.stdout.trim();
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      ready = (await fetch(url + '/health/ready')).ok;
    } catch {
      ready = false;
    }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(ready, true, 'Restored HTTP process must become ready.');
  token = undefined;
  token = (await call('/autenticacao/login', { login: 'reproduction-admin', senha: password }))
    .tokenAcesso;
  for (const proof of replayProofs)
    assert.deepEqual(await call('/eventos', proof.input), proof.result);
  await call('/autenticacao/logout', {});
  assert.equal(pg.sql('nfc_restore_test', 'SELECT count(*) FROM observations'), '10');
  assert.equal(pg.sql('nfc_restore_test', 'SELECT count(*) FROM movements'), '12');
  assert.equal(spawnSync('docker', ['stop', restoredApi], { env, shell: false }).status, 0);
  const worker = docker([
    'run',
    '-d',
    '--rm',
    '--no-deps',
    '-e',
    'DATABASE_URL',
    '-e',
    'APP_PROCESS_ROLE=events',
    'api',
  ]);
  let drained = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      pg.sql(
        'nfc_restore_test',
        "SELECT count(*) FROM outbox WHERE status IN ('PENDING','PROCESSING')",
      ) === '0'
    ) {
      drained = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(drained, true, 'Restored real worker must drain outbox.');
  const audit = pg.sql('nfc_restore_test', 'SELECT count(*) FROM audit_log');
  assert.notEqual(audit, '0');
  const stopped = spawnSync('docker', ['stop', worker], { env, shell: false });
  assert.equal(stopped.status, 0, 'Stop only the one-off restored worker created here.');
  const report = {
    schemaVersion: 1,
    status: 'REPRODUCAO_SOFTWARE_SINTETICA',
    project,
    apiSource: identity(root, 'api'),
    runtime,
    postgres: pg.version,
    migrations: Number(migrations),
    seedsIdempotent: true,
    scenarios: counts,
    observations: 10,
    movements: 12,
    backupTables: Object.keys(saved.tables).length,
    restored: recovered,
    restoredAuditRecords: Number(audit),
    restoredReplayResponsesVerified: replayProofs.length,
    restoredAppendOnlyTriggerVerified: true,
    migrationSequenceVerified: true,
    physicalReads: 0,
    sdmVaultRecoveryVerified: false,
  };
  fs.writeFileSync(path.join(folder, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
  });
  // Only the new project created above is stopped; backup/report and volume are retained.
  docker(['stop']);
  process.stdout.write(
    'Isolated install/HTTP/backup/restore/dispatcher passed. Evidence: ' + folder + '\n',
  );
}
main().catch((error) => {
  process.stderr.write(error.message + '\nProject retained for inspection: ' + project + '\n');
  process.exitCode = 1;
});
