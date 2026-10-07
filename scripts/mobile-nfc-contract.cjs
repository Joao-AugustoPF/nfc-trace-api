// Software-only interoperability rehearsal. Never accesses native NFC or the laboratory database.
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { identity, sha256 } = require('./source-identity.cjs');
const root = path.resolve(__dirname, '..');
const project = 'nfc-mobile-contract-' + randomUUID().slice(0, 8);
const folder = path.join(root, '.tmp', project);
function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    cwd: root,
    shell: false,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0)
    throw Error('CONTRACT: local command failed; no laboratory service was restarted.');
  return result.stdout.trim();
}
function check(condition, message) {
  if (!condition) throw Error('CONTRACT: ' + message);
}
async function main() {
  const args = process.argv.slice(2);
  check(
    args.length === 2 && args[0] === '--mobile-root',
    'Use npm run test:nfc:mobile -- --mobile-root CAMINHO_DO_NOVA_TAG.',
  );
  const mobile = fs.realpathSync(path.resolve(args[1]));
  check(
    JSON.parse(fs.readFileSync(path.join(mobile, 'package.json'), 'utf8')).name === 'NovaTag',
    'The selected checkout must be NovaTag.',
  );
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'compose.env'), '', { flag: 'wx' });
  const compiled = path.join(folder, 'mobile');
  command(
    process.execPath,
    [
      path.join(mobile, 'node_modules/typescript/bin/tsc'),
      '--ignoreConfig',
      '--module',
      'node16',
      '--moduleResolution',
      'node16',
      '--target',
      'es2022',
      '--strict',
      '--skipLibCheck',
      '--rootDir',
      path.join(mobile, 'src'),
      '--outDir',
      compiled,
      ...[
        'appplication/administration/coordinator.ts',
        'infra/administration/sqlite-store.ts',
        'appplication/auth/session-manager.ts',
        'infra/auth/http-transport.ts',
        'appplication/offline/coordinator.ts',
        'infra/offline/sqlite-store.ts',
      ].map((file) => path.join(mobile, 'src', file)),
    ],
    { cwd: mobile },
  );
  const env = { ...process.env, NFC_CONTRACT_DB_PASSWORD: randomBytes(24).toString('hex') };
  const compose = [
    'compose',
    '--env-file',
    path.join(folder, 'compose.env'),
    '-p',
    project,
    '-f',
    path.join(root, 'infra/compose.nfc-contract.yaml'),
  ];
  let started = false;
  try {
    started = true;
    command('docker', [...compose, 'up', '-d', '--wait', '--wait-timeout', '120'], { env });
    const address = command('docker', [...compose, 'port', 'postgres', '5432'], { env });
    check(
      /^127\.0\.0\.1:\d+$/.test(address),
      'The private test database must be bound to loopback.',
    );
    require('ts-node').register({
      project: path.join(root, 'tsconfig.json'),
      transpileOnly: true,
      compilerOptions: { rootDir: root },
    });
    const { runContract } = require('../test/mobile-nfc-contract.cjs');
    const result = await runContract({
      compiled,
      folder,
      databaseUrl: `postgresql://contract:${env.NFC_CONTRACT_DB_PASSWORD}@${address}/nfc_mobile_contract_test`,
      check,
    });
    const report = {
      schemaVersion: 1,
      evidence: 'SOFTWARE_SINTETICO_SEM_NFC_FISICO',
      physicalReads: 0,
      nativeSdkExercised: false,
      harnessSha256: Object.fromEntries(
        [
          'scripts/mobile-nfc-contract.cjs',
          'test/mobile-nfc-contract.cjs',
          'test/nfc-personalization-picc.ts',
          'infra/compose.nfc-contract.yaml',
        ].map((file) => [file, sha256(fs.readFileSync(path.join(root, file)))]),
      ),
      api: identity(root, 'api'),
      mobile: identity(mobile, 'mobile'),
      ...result,
    };
    fs.writeFileSync(path.join(folder, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
    });
    process.stdout.write(
      `PASS: ${result.cases.length} interoperability cases; HTTP/PostgreSQL/SQLite real, synthetic PICC, zero physical reads.\nReport: ${path.join(folder, 'report.json')}\n`,
    );
  } finally {
    if (started) command('docker', [...compose, 'down', '--volumes', '--remove-orphans'], { env });
  }
}
main().catch((error) => {
  if (error.name === 'TSError')
    process.stderr.write(`Compiler diagnostic codes: ${JSON.stringify(error.diagnosticCodes)}\n`);
  // Do not print exceptions from cryptography, SQL or HTTP: they can contain private values.
  process.stderr.write(
    /^CONTRACT: /.test(error.message)
      ? error.message + '\n'
      : `CONTRACT: interoperability failed (${error.code ?? error.name ?? 'UNKNOWN'}); no private response was printed.\n`,
  );
  process.exitCode = 1;
});
