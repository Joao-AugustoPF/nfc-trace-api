const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sha256 } = require('./source-identity.cjs');

function command(args, input) {
  const r = spawnSync('docker', args, { input, maxBuffer: 256 * 1024 * 1024, shell: false });
  if (r.status !== 0)
    throw Error('Docker/PostgreSQL command failed. No SQL or secret output was displayed.');
  return r.stdout;
}
function identifier(value) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value || '')) throw Error('Invalid database/user identifier.');
  return value;
}
function restricted(folder) {
  if (process.platform === 'win32') {
    const actor = spawnSync('whoami', [], { encoding: 'utf8' });
    if (actor.status !== 0) throw Error('Cannot identify file owner.');
    const acl = spawnSync(
      'icacls',
      [folder, '/inheritance:r', '/grant:r', actor.stdout.trim() + ':(OI)(CI)F'],
      { shell: false },
    );
    if (acl.status !== 0) throw Error('Cannot restrict backup folder ACL.');
  } else fs.chmodSync(folder, 0o700);
}
function postgres(container) {
  if (!/^[a-zA-Z0-9_-]+$/.test(container || '')) throw Error('Invalid container identifier.');
  const inspected = JSON.parse(command(['inspect', container]).toString())[0];
  if (!inspected.State.Running) throw Error('PostgreSQL container must be running.');
  const environment = Object.fromEntries(
    inspected.Config.Env.map((x) => [x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1)]),
  );
  const user = identifier(environment.POSTGRES_USER || 'postgres');
  const execute = (args, input) => command(['exec', '-i', inspected.Id, ...args], input);
  const version = execute(['postgres', '--version']).toString().trim();
  if (!version.includes('PostgreSQL) 18.')) throw Error('This procedure requires PostgreSQL 18.');
  const sql = (database, query) =>
    execute([
      'psql',
      '-X',
      '-v',
      'ON_ERROR_STOP=1',
      '-A',
      '-t',
      '-U',
      user,
      '-d',
      identifier(database),
      '-c',
      query,
    ])
      .toString()
      .trim();
  return { user, version, execute, sql, containerId: inspected.Id };
}
function snapshot(pg, database) {
  const names = JSON.parse(
    pg.sql(
      database,
      "SELECT coalesce(json_agg(tablename ORDER BY tablename),'[]') FROM pg_tables WHERE schemaname='public'",
    ),
  );
  const tables = {};
  for (const table of names) {
    identifier(table);
    const data = pg.sql(
      database,
      `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]')::text FROM "${table}" t`,
    );
    tables[table] = { rows: JSON.parse(data).length, sha256: sha256(data) };
  }
  return tables;
}
function backup(container, database, output) {
  const pg = postgres(container);
  const folder = path.resolve(output);
  fs.mkdirSync(folder, { mode: 0o700 });
  restricted(folder);
  const before = snapshot(pg, database);
  const bytes = pg.execute([
    'pg_dump',
    '-Fc',
    '--no-owner',
    '--no-acl',
    '-U',
    pg.user,
    '-d',
    identifier(database),
  ]);
  const after = snapshot(pg, database);
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw Error('Database changed during backup. Stop writers and repeat into a new folder.');
  fs.writeFileSync(path.join(folder, 'database.dump'), bytes, { flag: 'wx', mode: 0o600 });
  const manifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    postgres: pg.version,
    sourceDatabase: database,
    dumpSha256: sha256(bytes),
    tables: before,
    externalVaultIncluded: false,
    requirement: 'STOP_ALL_WRITERS_AND_BACK_UP_EXTERNAL_SDM_VAULT_SEPARATELY',
  };
  fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  return manifest;
}
function restore(container, database, input) {
  identifier(database);
  if (!database.endsWith('_test'))
    throw Error('Rehearsal restore requires a NEW database ending in _test.');
  const pg = postgres(container);
  const folder = path.resolve(input);
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
  const dump = fs.readFileSync(path.join(folder, 'database.dump'));
  if (manifest.schemaVersion !== 1 || manifest.dumpSha256 !== sha256(dump))
    throw Error('Backup checksum invalid.');
  if (pg.sql('postgres', `SELECT count(*) FROM pg_database WHERE datname='${database}'`) !== '0')
    throw Error('Restore target already exists; no existing database is changed or dropped.');
  pg.sql('postgres', `CREATE DATABASE "${database}"`);
  pg.execute(
    [
      'pg_restore',
      '--exit-on-error',
      '--single-transaction',
      '--no-owner',
      '--no-acl',
      '-U',
      pg.user,
      '-d',
      database,
    ],
    dump,
  );
  const actual = snapshot(pg, database);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.tables))
    throw Error('Restored table rows/hashes diverge. Preserve target for diagnosis.');
  return {
    schemaVersion: 1,
    targetDatabase: database,
    tablesVerified: Object.keys(actual).length,
    dumpSha256: manifest.dumpSha256,
    externalVaultRecovered: false,
  };
}
module.exports = { backup, restore, snapshot, postgres, identifier };
if (require.main === module) {
  const [action, container, database, directory] = process.argv.slice(2);
  try {
    if (!['backup', 'restore'].includes(action) || !directory)
      throw Error(
        'Usage: lab:backup -- backup|restore POSTGRES_CONTAINER DATABASE NEW_FOLDER|BACKUP_FOLDER',
      );
    const result =
      action === 'backup'
        ? backup(container, database, directory)
        : restore(container, database, directory);
    process.stdout.write(
      JSON.stringify(
        action === 'backup'
          ? { tables: Object.keys(result.tables).length, externalVaultIncluded: false }
          : result,
      ) + '\n',
    );
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  }
}
