const fs = require('node:fs');
const path = require('node:path');
const { identity, sha256 } = require('./source-identity.cjs');
const { apkIdentity } = require('./apk-identity.cjs');
const args = process.argv.slice(2);
function option(name) {
  const i = args.indexOf(name);
  return i < 0 ? null : args[i + 1];
}
function artifact(name) {
  const file = option('--' + name);
  return file
    ? {
        name: path.basename(file),
        bytes: fs.statSync(file).size,
        sha256: sha256(fs.readFileSync(file)),
        association: 'DECLARADA_PELO_EXECUTOR',
      }
    : null;
}
try {
  const mobile = option('--mobile'),
    output = option('--output');
  if (!mobile || !output)
    throw Error('Use --mobile CHECKOUT --output ARQUIVO_NOVO [--apk ARQUIVO] [--dataset ARQUIVO].');
  const apiRoot = path.resolve(__dirname, '..');
  const mobileRoot = path.resolve(mobile);
  const api = identity(apiRoot, 'api'),
    app = identity(mobileRoot, 'mobile');
  const apk = artifact('apk');
  if (apk) {
    apk.embedded = apkIdentity(option('--apk'));
    apk.embeddedSourceMatchesCheckout = apk.embedded.jsSource?.sourceSha256 === app.sourceSha256;
  }
  const buildPath = path.join(apiRoot, 'dist/build-info.json');
  const build = fs.existsSync(buildPath) ? JSON.parse(fs.readFileSync(buildPath, 'utf8')) : null;
  const configuration = JSON.parse(fs.readFileSync(path.join(mobileRoot, 'app.json'), 'utf8')).expo;
  const manifest = {
    schemaVersion: 1,
    status: 'CANDIDATO_NAO_ACEITO_FISICAMENTE',
    createdAt: new Date().toISOString(),
    api,
    mobile: {
      ...app,
      appVersion: configuration.version,
      androidPackage: configuration.android.package,
      androidVersionCode: configuration.android.versionCode ?? null,
      iosBundleIdentifier: configuration.ios.bundleIdentifier,
      iosBuildNumber: configuration.ios.buildNumber,
    },
    apiBuild: build
      ? {
          compiledSha256: build.compiledSha256,
          sourceSha256: build.sourceSha256,
          sourceMatchesCheckout: build.sourceSha256 === api.sourceSha256,
          revision: build.revision,
        }
      : null,
    artifacts: { apk, dataset: artifact('dataset') },
    protocol: {
      candidateSdmProfile: 'nfc-trace.sdm.encrypted-picc.v1',
      pilot: artifact('protocol'),
    },
    limitations: [
      'APK_ASSOCIATION_REQUIRES_BUILD_LOG_AND_INSTALLATION_CHECK',
      'PHYSICAL_ACCEPTANCE_AND_MAIN_INTEGRATION_PENDING',
      'NO_SECRETS_OR_ENV_INCLUDED',
    ],
  };
  fs.writeFileSync(path.resolve(output), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(
    'Manifesto candidato criado; hardware/instalação/integração final continuam pendentes.\n',
  );
} catch (error) {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
}
