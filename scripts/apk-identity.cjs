const { spawnSync } = require('node:child_process');
function apkIdentity(file) {
  const script = [
    'import sys,json,zipfile,hashlib',
    'with zipfile.ZipFile(sys.argv[1]) as z:',
    " c=json.loads(z.read('assets/app.config'))",
    " b=z.read('assets/index.android.bundle')",
    " print(json.dumps({'appVersion':c.get('version'),'androidVersionCode':c.get('android',{}).get('versionCode'),'jsSource':c.get('extra',{}).get('reproducibility'),'bundleSha256':hashlib.sha256(b).hexdigest()}))",
  ].join('\n');
  const result = spawnSync(process.env.EXPERIMENT_PYTHON || 'python', ['-c', script, file], {
    encoding: 'utf8',
    shell: false,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0)
    throw Error(
      'Cannot verify APK embedded config/bundle; Python and a standalone APK are required.',
    );
  return JSON.parse(result.stdout);
}
module.exports = { apkIdentity };
