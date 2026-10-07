const fs = require('node:fs');
const path = require('node:path');
const { identity, files, sha256 } = require('./source-identity.cjs');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist/build-info.json');
// Remove the previous metadata before hashing the output; it cannot hash itself.
if (fs.existsSync(output)) fs.unlinkSync(output);
const metadata = identity(root, 'api');
const compiled = files(root, ['dist']);
fs.writeFileSync(
  output,
  JSON.stringify(
    {
      ...metadata,
      nodeBuildVersion: process.version,
      compiledSha256: sha256(JSON.stringify(compiled)),
      compiledFiles: compiled,
    },
    null,
    2,
  ) + '\n',
);
process.stdout.write(
  'Build metadata written (source and compiled hashes; no environment values).\n',
);
