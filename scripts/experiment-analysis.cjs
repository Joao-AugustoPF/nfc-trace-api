// Keep Python work offline and avoid passing credentials to any subprocess.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const executable = process.env.EXPERIMENT_PYTHON || 'python';
const env = {
  ...process.env,
  PYTHONPATH: path.join(root, 'experiments'),
  PYTHONDONTWRITEBYTECODE: '1',
  PYTHONUTF8: '1',
  PYTHONIOENCODING: 'utf-8',
};
const result = spawnSync(executable, ['-m', 'nfc_analysis.cli', ...process.argv.slice(2)], {
  cwd: root,
  env,
  stdio: 'inherit',
  shell: false,
});
if (result.error) {
  process.stderr.write(
    'Python indisponível. Configure EXPERIMENT_PYTHON e instale experiments/requirements.lock.txt.\n',
  );
}
process.exitCode = result.status ?? 2;
