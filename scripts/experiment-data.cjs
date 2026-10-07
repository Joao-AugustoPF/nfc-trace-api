// Offline validation/CSV conversion does not connect to PostgreSQL or mutate the source.
require('ts-node').register({ project: require('node:path').join(__dirname, '../tsconfig.json') });
const fs = require('node:fs');
const path = require('node:path');
const { Sha256Fingerprint } = require('../src/platform/runtime');
const {
  validateDataset,
  summarizeDataset,
  datasetMetrics,
} = require('../src/bounded-contexts/experimentation/domain/dataset');
const { datasetCsv } = require('../src/bounded-contexts/experimentation/domain/csv');
async function main() {
  const [command, input, output] = process.argv.slice(2);
  if (!['validate', 'csv', 'export'].includes(command) || !input)
    throw Error(
      'Uso: experiment-data.cjs validate arquivo.json | csv arquivo.json pasta-nova | export RUN_UUID pasta-nova',
    );
  let bundle;
  if (command === 'export') {
    const base = process.env.EXPERIMENT_API_URL;
    if (!base || !process.env.EXPERIMENT_LOGIN || !process.env.EXPERIMENT_PASSWORD)
      throw Error(
        'Defina EXPERIMENT_API_URL, EXPERIMENT_LOGIN e EXPERIMENT_PASSWORD sem passá-los na linha de comando.',
      );
    const url = new URL(base);
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      throw Error('Use HTTPS fora do laboratório local.');
    if (!/^[0-9a-f-]{36}$/i.test(input)) throw Error('UUID de execução inválido.');
    const login = await fetch(base.replace(/\/$/, '') + '/autenticacao/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        login: process.env.EXPERIMENT_LOGIN,
        senha: process.env.EXPERIMENT_PASSWORD,
      }),
      signal: AbortSignal.timeout(20000),
    });
    const session = await login.json();
    if (!login.ok) throw Error('Autenticação recusada.');
    const token = session.dados?.tokenAcesso;
    if (!token) throw Error('Resposta de autenticação inválida.');
    const response = await fetch(
      base.replace(/\/$/, '') + '/experimentos/' + input + '/exportacao',
      { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(30000) },
    );
    if (!response.ok) throw Error('Exportação recusada (HTTP ' + response.status + ').');
    bundle = (await response.json()).dados;
  } else bundle = JSON.parse(fs.readFileSync(path.resolve(input), 'utf8'));
  const integrity = validateDataset(bundle?.dataset);
  if (bundle?.checksum !== new Sha256Fingerprint().of(bundle?.dataset))
    integrity.errors.push('CHECKSUM_DIVERGENTE');
  if (integrity.errors.length) integrity.status = 'INCONSISTENTE';
  const report = {
    schemaVersion: 1,
    integrity,
    summary: integrity.errors.length ? [] : summarizeDataset(bundle.dataset),
    metrics: integrity.errors.length ? [] : datasetMetrics(bundle.dataset),
  };
  if (command === 'validate') {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.exitCode = integrity.errors.length ? 2 : 0;
    return;
  }
  if (integrity.errors.length)
    throw Error('Dataset inconsistente; valide o arquivo antes da conversão.');
  if (!output) throw Error('Informe uma pasta nova para a exportação.');
  const folder = path.resolve(output);
  fs.mkdirSync(folder, { recursive: false });
  fs.writeFileSync(path.join(folder, 'dataset.json'), JSON.stringify(bundle, null, 2), 'utf8');
  fs.writeFileSync(path.join(folder, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  for (const [name, csv] of Object.entries(datasetCsv(bundle.dataset)))
    fs.writeFileSync(path.join(folder, name), csv, 'utf8');
  process.stdout.write('Dataset e CSVs exportados; integridade ' + integrity.status + '.\n');
}
main().catch(() => {
  process.stderr.write(
    'Falha na exportação/validação. Confira argumentos, permissões, estrutura e checksum. Nenhuma credencial foi exibida.\n',
  );
  process.exitCode = 1;
});
