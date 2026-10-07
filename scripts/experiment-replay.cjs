// Reexecute frozen fixture messages as a limited operator. This never opens an NFC session.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
async function main() {
  const [inputFile, outputDirectory] = process.argv.slice(2);
  if (!inputFile || !outputDirectory) throw Error('Informe fixture.json e uma pasta nova.');
  const fixture = JSON.parse(fs.readFileSync(path.resolve(inputFile), 'utf8'));
  if (
    fixture.schemaVersion !== 1 ||
    !Array.isArray(fixture.steps) ||
    !fixture.steps.length ||
    fixture.steps.length > 500
  )
    throw Error('Estrutura de fixture inválida.');
  const base = process.env.EXPERIMENT_API_URL?.replace(/\/$/, '');
  if (!base || !process.env.EXPERIMENT_LOGIN || !process.env.EXPERIMENT_PASSWORD)
    throw Error('Credenciais e URL precisam estar nas variáveis EXPERIMENT_*');
  const url = new URL(base);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw Error('Use HTTPS fora do laboratório.');
  const login = await fetch(base + '/autenticacao/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      login: process.env.EXPERIMENT_LOGIN,
      senha: process.env.EXPERIMENT_PASSWORD,
    }),
    signal: AbortSignal.timeout(20000),
  });
  const session = (await login.json()).dados;
  if (!login.ok || session?.usuario?.perfil !== 'OPERADOR' || !session.tokenAcesso)
    throw Error('Este executor exige uma conta OPERADOR.');
  const token = session.tokenAcesso;
  async function request(route, body) {
    const response = await fetch(base + route, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20000),
    });
    return { status: response.status, result: await response.json() };
  }
  try {
    assert.match(fixture.runId, /^[0-9a-f-]{36}$/i);
    const runs = [];
    for (let page = 1; page <= 10000; page++) {
      const r = await request('/experimentos?pagina=' + page + '&limite=100');
      assert.equal(r.status, 200);
      runs.push(...r.result.dados.items);
      if (page * 100 >= r.result.dados.total) break;
    }
    const run = runs.find((r) => r.input.id === fixture.runId);
    assert.ok(run && ['FISICO', 'SINTETICO'].includes(run.input.dataKind));
    const trials = [];
    for (let page = 1; page <= 10000; page++) {
      const r = await request(
        '/experimentos/' + fixture.runId + '/tentativas?pagina=' + page + '&limite=100',
      );
      assert.equal(r.status, 200);
      trials.push(...r.result.dados.items);
      if (page * 100 >= r.result.dados.total) break;
    }
    for (const step of fixture.steps) {
      const trial = trials.find((t) => t.input.id === step.trialId)?.input;
      assert.equal(
        trial?.mode,
        run.input.dataKind === 'FISICO' ? 'REEXECUCAO' : 'SINTETICA',
        'Separe reexecuções de leituras físicas; fixtures sintéticas ficam em execuções SINTETICO.',
      );
      assert.equal(trial.provisioningId, step.body?.provisionamentoId);
      assert.equal(trial.deviceId, step.body?.dispositivoId);
      assert.ok(step.expect && Number.isInteger(step.expect.httpStatus));
      assert.ok(
        Number.isInteger(step.repeat ?? 1) && (step.repeat ?? 1) > 0 && (step.repeat ?? 1) <= 20,
      );
    }
    const folder = path.resolve(outputDirectory);
    fs.mkdirSync(folder, { recursive: false });
    fs.writeFileSync(path.join(folder, 'fixture.json'), JSON.stringify(fixture, null, 2));
    const clockId = randomUUID(),
      outcomes = [];
    for (const step of fixture.steps) {
      const trial = trials.find((t) => t.input.id === step.trialId).input;
      const attemptId = randomUUID();
      const stage = async (
        kind,
        observationId = null,
        durationMs = null,
        boundary = 'INSTANTE',
        code = null,
      ) => {
        const record = {
          id: randomUUID(),
          trialId: trial.id,
          attemptId,
          stage: kind,
          observationId,
          deviceId: trial.deviceId,
          occurredAt: new Date().toISOString(),
          clockId,
          monotonicMs: performance.now(),
          durationMs,
          boundary,
          code,
        };
        // Persist before the HTTP acknowledgment; the file is a replay journal, not a phone capture.
        fs.appendFileSync(path.join(folder, 'stages.jsonl'), JSON.stringify(record) + '\n');
        const response = await request('/experimentos/registros', record);
        assert.equal(response.status, 200);
      };
      await stage('TENTATIVA_INICIADA');
      await stage('LEITURA_OK', null, null, 'SESSAO_NFC_ATE_EVIDENCIA');
      await stage('CAPTURA_LOCAL', step.body.id);
      for (let send = 0; send < (step.repeat ?? 1); send++) {
        await stage('ENVIO_INICIADO', step.body.id);
        const start = performance.now();
        const response = await request('/eventos', step.body);
        const duration = performance.now() - start;
        await stage(
          response.status === 200 && !step.discardResponse ? 'ENVIO_CONFIRMADO' : 'ENVIO_FALHOU',
          step.body.id,
          duration,
          'ENVIO_ATE_RESPOSTA',
          step.discardResponse
            ? 'RESPOSTA_PERDIDA'
            : response.status === 200
              ? 'OK'
              : 'ENVIO_RECUSADO',
        );
        assert.equal(response.status, step.expect.httpStatus);
        if ('authorized' in step.expect)
          assert.equal(response.result.dados?.decisao?.autorizada, step.expect.authorized);
        if ('reason' in step.expect)
          assert.equal(response.result.dados?.decisao?.motivo, step.expect.reason);
        outcomes.push({
          trialId: trial.id,
          observationId: step.body.id,
          send,
          status: response.status,
          decision: response.result.dados?.decisao ?? null,
          mode: 'REEXECUCAO',
          dataKind: run.input.dataKind,
          physicalRead: false,
        });
        fs.writeFileSync(
          path.join(folder, 'results.json'),
          JSON.stringify(
            {
              schemaVersion: 1,
              runId: fixture.runId,
              mode: 'REEXECUCAO',
              dataKind: run.input.dataKind,
              physicalRead: false,
              outcomes,
            },
            null,
            2,
          ),
        );
      }
    }
    process.stdout.write(
      'Reexecuções verificadas: ' + outcomes.length + '. Nenhuma nova leitura NFC foi realizada.\n',
    );
  } finally {
    await request('/autenticacao/logout', {}).catch(() => {});
  }
}
main().catch(() => {
  process.stderr.write(
    'Reexecução não concluída. Confira a fixture, suas expectativas, as permissões e os registros na pasta de saída.\n',
  );
  process.exitCode = 1;
});
