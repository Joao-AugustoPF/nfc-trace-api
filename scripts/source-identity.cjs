const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function files(root, entries) {
  const result = {};
  function visit(relative) {
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute)) return;
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw Error('Source identity does not follow symbolic links.');
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) visit(path.join(relative, name));
    } else result[relative.replaceAll('\\', '/')] = sha256(fs.readFileSync(absolute));
  }
  entries.forEach(visit);
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b, 'en')));
}
function git(root, args) {
  const command = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', shell: false });
  return command.status === 0 ? command.stdout.trim() : null;
}
function identity(root, kind) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const common = ['src', 'package.json', 'package-lock.json', 'tsconfig.json'];
  const scopes =
    kind === 'api'
      ? [
          ...common,
          'tsconfig.build.json',
          'scripts/build-metadata.cjs',
          'scripts/source-identity.cjs',
        ]
      : [
          ...common,
          'index.js',
          'App.tsx',
          'app.json',
          'app.config.js',
          'babel.config.js',
          'metro.config.js',
          'assets',
          'scripts/source-identity.cjs',
        ];
  const hashes = files(root, scopes);
  const revision = git(root, ['rev-parse', 'HEAD']);
  const declared = process.env.BUILD_REVISION;
  if (declared && !/^[0-9a-f]{40}$/i.test(declared))
    throw Error('BUILD_REVISION must be a full Git SHA.');
  return {
    schemaVersion: 1,
    kind,
    packageVersion: pkg.version,
    revision: revision || declared || null,
    revisionSource: revision ? 'GIT' : declared ? 'DECLARADA' : 'INDISPONIVEL',
    trackedChanges: revision
      ? !!git(root, ['status', '--porcelain', '--untracked-files=no'])
      : null,
    sourceSha256: sha256(JSON.stringify(hashes)),
    lockSha256: hashes['package-lock.json'],
    files: hashes,
  };
}
module.exports = { sha256, files, identity };
