const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const result = spawnSync(
  process.env.EXPERIMENT_PYTHON || 'python',
  ['-m', 'unittest', 'discover', '-s', 'experiments/tests', '-v'],
  {
    cwd: root,
    env: {
      ...process.env,
      PYTHONPATH: path.join(root, 'experiments'),
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
    },
    stdio: 'inherit',
    shell: false,
  },
);
if (result.error) process.stderr.write('Python indisponível para os testes da análise.\n');
process.exitCode = result.status ?? 2;
