import {
  CLIENT_STAGES,
  SCENARIOS,
  Dataset,
  GroundTruthRecord,
  Stored,
  ClientRecordInput,
} from './types';
import { assertClientRecord, assertTrial, assertGroundTruth } from './rules';

export interface Integrity {
  status: 'COMPLETO' | 'INCOMPLETO' | 'INCONSISTENTE';
  errors: string[];
  warnings: string[];
}
export function validateDataset(value: unknown): Integrity {
  const errors: string[] = [];
  const warnings: string[] = [];
  const d = value as Dataset | undefined;
  if (
    !d ||
    d.schemaVersion !== 1 ||
    !d.run?.input?.id ||
    !Array.isArray(d.trials) ||
    !Array.isArray(d.groundTruth) ||
    !Array.isArray(d.clientRecords) ||
    !Array.isArray(d.observations) ||
    !Array.isArray(d.serverMeasurements)
  )
    return { status: 'INCONSISTENTE', errors: ['ESTRUTURA_INVALIDA'], warnings: [] };
  const object = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);
  if (
    ![...d.trials, ...d.groundTruth, ...d.clientRecords].every(
      (r) => object(r) && object(r.input),
    ) ||
    !d.observations.every(
      (o) =>
        object(o) &&
        Array.isArray(o.decisions) &&
        o.decisions.every((r) => object(r) && object(r.result)) &&
        Array.isArray(o.movements),
    ) ||
    !d.serverMeasurements.every(object)
  )
    return { status: 'INCONSISTENTE', errors: ['REGISTRO_MALFORMADO'], warnings: [] };
  const unique = (ids: string[], name: string) => {
    if (new Set(ids).size !== ids.length || ids.some((id) => !id))
      errors.push('IDENTIDADE_DUPLICADA_OU_AUSENTE:' + name);
  };
  const uuid = (v: unknown) =>
    typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
  const text = (v: unknown) => typeof v === 'string' && v.length > 0;
  if (
    !uuid(d.run.input.id) ||
    !['SINTETICO', 'FISICO'].includes(d.run.input.dataKind) ||
    ![
      d.run.input.name,
      d.run.input.protocolVersion,
      d.run.input.apiVersion,
      d.run.input.mobileVersion,
    ].every(text) ||
    !object(d.run.input.configuration) ||
    !Number.isInteger(d.run.input.configuration.timeoutMs) ||
    d.run.input.configuration.timeoutMs <= 0
  )
    errors.push('EXECUCAO_INVALIDA');
  for (const t of d.trials)
    if (
      ![t.input.id, t.input.runId, t.input.sessionId, t.input.provisioningId].every(uuid) ||
      ![
        t.input.tagLabel,
        t.input.boxLabel,
        t.input.deviceId,
        t.input.deviceModel,
        t.input.osVersion,
        t.input.eventType,
      ].every(text) ||
      !SCENARIOS.includes(t.input.scenario) ||
      !['UID', 'NDEF_ESTATICO', 'SDM'].includes(t.input.treatment) ||
      !['LEITURA_FISICA', 'REEXECUCAO', 'SINTETICA'].includes(t.input.mode) ||
      !Number.isInteger(t.input.ordinal) ||
      t.input.ordinal < 1
    )
      errors.push('ROTEIRO_INVALIDO:' + t.input.id);
  for (const g of d.groundTruth)
    if (
      !uuid(g.input.id) ||
      !uuid(g.input.trialId) ||
      typeof g.input.legitimate !== 'boolean' ||
      typeof g.input.shouldAuthorize !== 'boolean' ||
      typeof g.input.excluded !== 'boolean' ||
      !Number.isInteger(g.input.observedOrdinal) ||
      g.input.observedOrdinal < 1 ||
      !Number.isFinite(Date.parse(g.input.observedAt)) ||
      ![g.input.observedBox, g.input.observedTag].every(text)
    )
      errors.push('GROUND_TRUTH_INCOMPLETO:' + g.input.id);
  unique(
    d.trials.map((t) => t.input?.id),
    'trials',
  );
  unique(
    d.clientRecords.map((t) => t.input?.id),
    'clientRecords',
  );
  unique(
    d.observations.map((o) => o.id),
    'observations',
  );
  unique(
    d.groundTruth.map((g) => g.input?.id),
    'groundTruth',
  );
  const trials = new Map(d.trials.map((t) => [t.input?.id, t.input]));
  const observations = new Map(d.observations.map((o) => [o.id, o]));
  for (const t of d.trials) {
    try {
      assertTrial(d.run.input, t.input, { strategy: t.input.treatment, policy: t.input.policy });
    } catch {
      errors.push('ORIGEM_TENTATIVA_DIVERGENTE:' + t.input.id);
    }
    if (!t.input || t.input.runId !== d.run.input.id)
      errors.push('EXECUCAO_DIVERGENTE:' + t.input?.id);
    if (!d.groundTruth.some((g) => g.input?.trialId === t.input?.id))
      warnings.push('GROUND_TRUTH_AUSENTE:' + t.input?.id);
    if (!d.clientRecords.some((r) => r.input?.trialId === t.input?.id))
      warnings.push('TENTATIVA_NAO_EXECUTADA:' + t.input?.id);
  }
  for (const g of d.groundTruth) {
    try {
      assertGroundTruth(d.run.input, g.input);
    } catch {
      errors.push('GROUND_TRUTH_INVALIDO:' + g.input.id);
    }
    if (!g.input || !trials.has(g.input.trialId) || !Number.isInteger(g.revision) || g.revision < 1)
      errors.push('GROUND_TRUTH_INVALIDO:' + g.input?.id);
    else if ((d.run.input.dataKind === 'SINTETICO') !== (g.input.source === 'ROTEIRO_SINTETICO'))
      errors.push('ORIGEM_GROUND_TRUTH_DIVERGENTE:' + g.input.id);
  }
  const attempts = new Map<string, Stored<ClientRecordInput>[]>();
  const captureTrials = new Map<string, string>();
  for (const row of d.clientRecords) {
    const r = row.input;
    const trial = trials.get(r?.trialId);
    if (
      !r ||
      !trial ||
      !CLIENT_STAGES.includes(r.stage) ||
      r.deviceId !== trial.deviceId ||
      !Number.isFinite(r.monotonicMs) ||
      r.monotonicMs < 0 ||
      (r.durationMs !== null && (!Number.isFinite(r.durationMs) || r.durationMs < 0))
    ) {
      errors.push('ESTAGIO_INVALIDO:' + r?.id);
      continue;
    }
    const a = attempts.get(r.attemptId) ?? [];
    a.push(row);
    attempts.set(r.attemptId, a);
    try {
      assertClientRecord(trial, r);
    } catch {
      errors.push('FRONTEIRA_INVALIDA:' + r.id);
    }
    if (
      !uuid(r.id) ||
      !uuid(r.clockId) ||
      !uuid(r.attemptId) ||
      (r.observationId !== null && !uuid(r.observationId)) ||
      !Number.isFinite(Date.parse(r.occurredAt))
    )
      errors.push('IDENTIDADE_MEDICAO_INVALIDA:' + r.id);
    if (r.observationId) {
      const prior = captureTrials.get(r.observationId);
      if (prior && prior !== r.trialId)
        errors.push('CAPTURA_ASSOCIADA_A_MULTIPLAS_TENTATIVAS:' + r.observationId);
      captureTrials.set(r.observationId, r.trialId);
      const o = observations.get(r.observationId);
      if (
        o &&
        (o.userId !== row.userId ||
          o.deviceId !== r.deviceId ||
          o.provisioningId !== trial.provisioningId ||
          o.strategy !== trial.treatment)
      )
        errors.push('CAPTURA_CONTEXTO_DIVERGENTE:' + r.observationId);
      if (!o && r.stage === 'CAPTURA_LOCAL')
        warnings.push('CAPTURA_SEM_SERVIDOR:' + r.observationId);
      if (
        !o &&
        ['ENVIO_CONFIRMADO', 'CONFIRMACAO_FINAL', 'RECONCILIACAO_CONCLUIDA'].includes(r.stage)
      )
        errors.push('CONFIRMACAO_SEM_SERVIDOR:' + r.observationId);
    }
    if (r.durationMs === null && r.boundary !== 'INSTANTE')
      warnings.push('DURACAO_CENSURADA:' + r.id);
  }
  for (const [id, rows] of attempts) {
    if (
      new Set(rows.map((r) => r.input.trialId)).size > 1 ||
      new Set(rows.map((r) => r.userId)).size > 1
    )
      errors.push('TENTATIVA_CONTEXTO_DIVERGENTE:' + id);
    if (rows.filter((r) => r.input.stage === 'TENTATIVA_INICIADA').length !== 1)
      errors.push('INICIO_AUSENTE_OU_DUPLICADO:' + id);
    const ends = rows.filter((r) =>
      ['LEITURA_OK', 'LEITURA_FALHOU', 'LEITURA_INTERROMPIDA'].includes(r.input.stage),
    );
    if (ends.length > 1) errors.push('LEITURA_TERMINAL_DUPLICADA:' + id);
    if (!ends.length) warnings.push('LEITURA_NAO_CONCLUIDA:' + id);
    for (const stage of [
      'CONFIRMACAO_LOCAL',
      'CONFIRMACAO_FINAL',
      'COMUNICACAO_LIBERADA',
      'RECONCILIACAO_CONCLUIDA',
    ])
      if (rows.filter((r) => r.input.stage === stage).length > 1)
        errors.push('MARCO_DUPLICADO:' + id + ':' + stage);
    const starts = rows.filter((r) => r.input.stage === 'TENTATIVA_INICIADA');
    if (
      ends.some((e) =>
        starts.some(
          (s) => s.input.clockId === e.input.clockId && e.input.monotonicMs < s.input.monotonicMs,
        ),
      )
    )
      errors.push('RELOGIO_REGREDIU:' + id);
    if (
      rows.some((r) => r.input.stage === 'CAPTURA_LOCAL') &&
      !ends.some((e) => e.input.stage === 'LEITURA_OK')
    )
      errors.push('CAPTURA_SEM_LEITURA_COMPLETA:' + id);
  }
  for (const id of trials.keys()) {
    const revisions = d.groundTruth
      .filter((g) => g.input.trialId === id)
      .map((g) => g.revision)
      .sort((a, b) => a - b);
    if (revisions.some((r, i) => r !== i + 1))
      errors.push('GROUND_TRUTH_REVISOES_INCONSISTENTES:' + id);
  }
  for (const o of d.observations) {
    if (!Array.isArray(o.decisions) || !Array.isArray(o.movements)) {
      errors.push('HISTORICO_AUSENTE:' + o.id);
      continue;
    }
    if (o.decisions.some((r, i) => r.revision !== i + 1) || !o.decisions.length)
      errors.push('REVISOES_INCONSISTENTES:' + o.id);
    const last = o.decisions.at(-1)?.result;
    if (
      !object(o.receipt) ||
      o.decisions.some(
        (r) =>
          typeof r.result.accepted !== 'boolean' ||
          !['AUTORIZADA', 'REJEITADA', 'PENDENTE', 'TARDIA'].includes(String(r.result.status)),
      )
    )
      errors.push('DECISAO_INVALIDA:' + o.id);
    if (o.movements.length > 1 || (last?.accepted === true) !== (o.movements.length === 1))
      errors.push('EFEITO_DIVERGENTE:' + o.id);
    if (last?.status === 'PENDENTE') warnings.push('PENDENCIA_NAO_RESOLVIDA:' + o.id);
    if (
      !o.input ||
      o.input.id !== o.id ||
      o.input.provisionamentoId !== o.provisioningId ||
      o.input.tipo !== o.eventType ||
      o.input.dispositivoId !== o.deviceId
    )
      errors.push('SNAPSHOT_DIVERGENTE:' + o.id);
  }
  for (const m of d.serverMeasurements)
    if (
      !observations.has(m.observationId) ||
      !observations.get(m.observationId)?.decisions.some((r) => r.revision === m.revision) ||
      !Number.isFinite(m.startMs) ||
      !Number.isFinite(m.endMs) ||
      m.startMs < 0 ||
      m.endMs < m.startMs ||
      !m.clockId
    )
      errors.push('MEDICAO_SERVIDOR_INVALIDA:' + m.observationId);
  if (!d.trials.length) warnings.push('EXECUCAO_SEM_TENTATIVAS');
  return {
    status: errors.length ? 'INCONSISTENTE' : warnings.length ? 'INCOMPLETO' : 'COMPLETO',
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
  };
}

export function summarizeDataset(d: Dataset) {
  const truths = new Map<string, GroundTruthRecord>();
  for (const g of d.groundTruth)
    if (g.revision > (truths.get(g.input.trialId)?.revision ?? 0)) truths.set(g.input.trialId, g);
  return d.trials.map((t) => {
    const records = d.clientRecords.filter((r) => r.input.trialId === t.input.id);
    const ids = new Set(
      records.flatMap((r) => (r.input.observationId ? [r.input.observationId] : [])),
    );
    const observations = d.observations.filter((o) => ids.has(o.id));
    const truth = truths.get(t.input.id)?.input ?? null;
    const decisions = observations.map((o) => o.decisions.at(-1)?.result);
    const eligible = !!truth && !truth.excluded;
    const authorized = decisions.filter((d) => d?.accepted === true).length;
    const rejected = decisions.filter((d) => d?.status === 'REJEITADA').length;
    return {
      trialId: t.input.id,
      dataKind: d.run.input.dataKind,
      sessionId: t.input.sessionId,
      tagLabel: t.input.tagLabel,
      boxLabel: t.input.boxLabel,
      deviceId: t.input.deviceId,
      treatment: t.input.treatment,
      policy: t.input.policy,
      scenario: t.input.scenario,
      mode: t.input.mode,
      physicalReadAttempts:
        t.input.mode === 'LEITURA_FISICA'
          ? records.filter((r) => r.input.stage === 'TENTATIVA_INICIADA').length
          : 0,
      physicalReadSuccess:
        t.input.mode === 'LEITURA_FISICA'
          ? records.filter((r) => r.input.stage === 'LEITURA_OK').length
          : 0,
      readAttempts: records.filter((r) => r.input.stage === 'TENTATIVA_INICIADA').length,
      readSuccess: records.filter((r) => r.input.stage === 'LEITURA_OK').length,
      readFailures: records.filter((r) => r.input.stage === 'LEITURA_FALHOU').length,
      readInterrupted: records.filter((r) => r.input.stage === 'LEITURA_INTERROMPIDA').length,
      localCaptures: new Set(
        records.filter((r) => r.input.stage === 'CAPTURA_LOCAL').map((r) => r.input.observationId),
      ).size,
      storedCaptures: observations.length,
      authorized,
      rejected,
      pending: decisions.filter((d) => d?.status === 'PENDENTE').length,
      late: decisions.filter((d) => d?.status === 'TARDIA').length,
      authenticated: decisions.filter(
        (d) => (d?.sdm as { autenticada?: boolean })?.autenticada === true,
      ).length,
      previouslyUsed: decisions.filter(
        (d) => (d?.sdm as { previamenteUtilizada?: boolean })?.previamenteUtilizada === true,
      ).length,
      duplicateEffects: observations.reduce((n, o) => n + Math.max(0, o.movements.length - 1), 0),
      truthKnown: !!truth,
      excluded: truth?.excluded ?? false,
      falseAccepts: eligible && !truth!.legitimate && !truth!.shouldAuthorize ? authorized : 0,
      falseAcceptDenominator:
        eligible && !truth!.legitimate && !truth!.shouldAuthorize ? observations.length : 0,
      falseRejects:
        eligible && truth!.legitimate && truth!.shouldAuthorize
          ? rejected + decisions.filter((d) => d?.status === 'TARDIA').length
          : 0,
      falseRejectsWithoutLate:
        eligible && truth!.legitimate && truth!.shouldAuthorize ? rejected : 0,
      lateLegitimate:
        eligible && truth!.legitimate ? decisions.filter((d) => d?.status === 'TARDIA').length : 0,
      falseRejectDenominator:
        eligible && truth!.legitimate && truth!.shouldAuthorize ? observations.length : 0,
      durations: [
        ...records
          .filter((r) => r.input.durationMs !== null)
          .map((r) => ({
            source: 'MOBILE_DECLARADO',
            boundary: r.input.boundary,
            clockId: r.input.clockId,
            ms: r.input.durationMs,
          })),
        ...d.serverMeasurements
          .filter((m) => ids.has(m.observationId))
          .map((m) => ({
            source: 'SERVIDOR',
            boundary: m.boundary,
            clockId: m.clockId,
            ms: m.endMs - m.startMs,
          })),
      ],
    };
  });
}

export function datasetMetrics(d: Dataset) {
  const summary = summarizeDataset(d);
  const groups = new Map<string, typeof summary>();
  const complete = validateDataset(d).status === 'COMPLETO';
  for (const row of summary) {
    const key = JSON.stringify([row.dataKind, row.mode, row.treatment, row.policy]);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const rate = (numerator: number, denominator: number) => ({
    numerator,
    denominator,
    value: denominator ? numerator / denominator : null,
  });
  return [...groups.values()].map((rows) => {
    const first = rows[0]!;
    const total = (
      field:
        | 'readAttempts'
        | 'readSuccess'
        | 'readFailures'
        | 'readInterrupted'
        | 'physicalReadAttempts'
        | 'physicalReadSuccess'
        | 'localCaptures'
        | 'storedCaptures'
        | 'authorized'
        | 'rejected'
        | 'pending'
        | 'late'
        | 'falseAccepts'
        | 'falseAcceptDenominator'
        | 'falseRejects'
        | 'falseRejectDenominator'
        | 'duplicateEffects'
        | 'authenticated'
        | 'previouslyUsed',
    ) => rows.reduce((n, r) => n + r[field], 0);
    return {
      dataKind: first.dataKind,
      mode: first.mode,
      treatment: first.treatment,
      policy: first.policy,
      status: !complete || total('pending') ? 'PROVISORIO' : 'FINAL',
      physicalReadSuccess: rate(total('physicalReadSuccess'), total('physicalReadAttempts')),
      readStageSuccess: rate(total('readSuccess'), total('readAttempts')),
      preservation: rate(total('storedCaptures'), total('localCaptures')),
      falseAcceptance: rate(total('falseAccepts'), total('falseAcceptDenominator')),
      falseRejection: rate(total('falseRejects'), total('falseRejectDenominator')),
      authorized: total('authorized'),
      rejected: total('rejected'),
      pending: total('pending'),
      late: total('late'),
      readFailures: total('readFailures'),
      readInterrupted: total('readInterrupted'),
      duplicateEffects: total('duplicateEffects'),
      authenticated: total('authenticated'),
      previouslyUsed: total('previouslyUsed'),
      clusters: rows.map((r) => ({
        trialId: r.trialId,
        tagLabel: r.tagLabel,
        deviceId: r.deviceId,
        sessionId: r.sessionId,
      })),
      durations: rows.flatMap((r) =>
        r.durations.map((s) => ({ ...s, trialId: r.trialId, unit: 'ms' })),
      ),
      reconciliationGroups: reconciliationGroups(d, new Set(rows.map((r) => r.trialId))),
    };
  });
}

function reconciliationGroups(d: Dataset, trialIds: Set<string>) {
  const groups = new Map<string, ClientRecordInput[]>();
  for (const { input: r } of d.clientRecords.filter(
    (row) => trialIds.has(row.input.trialId) && row.input.stage === 'COMUNICACAO_LIBERADA',
  )) {
    const key = JSON.stringify([r.clockId, r.monotonicMs]);
    const group = groups.get(key) ?? [];
    group.push(r);
    groups.set(key, group);
  }
  return [...groups.values()].map((releases) => {
    const first = releases[0]!;
    const finals = releases.map(
      (r) =>
        d.clientRecords.find(
          (row) =>
            row.input.attemptId === r.attemptId && row.input.stage === 'RECONCILIACAO_CONCLUIDA',
        )?.input,
    );
    const complete = finals.every((r) => r && r.clockId === first.clockId && r.durationMs !== null);
    return {
      clockId: first.clockId,
      startMs: first.monotonicMs,
      unit: 'ms',
      eligible: releases.length,
      finals: finals.filter(Boolean).length,
      complete,
      durationMs: complete ? Math.max(...finals.map((r) => r!.durationMs!)) : null,
      attemptIds: releases.map((r) => r.attemptId),
    };
  });
}
