import { Dataset } from './types';

// Text cells are protected from spreadsheet formula execution. JSON remains authoritative.
function cell(value: unknown): string {
  let text =
    value === null || value === undefined
      ? ''
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
  if (typeof value === 'string' && /^[\s]*[=+@-]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
function table(rows: Record<string, unknown>[], fields: string[]) {
  return (
    fields.map(cell).join(',') +
    '\r\n' +
    rows.map((row) => fields.map((key) => cell(row[key])).join(',')).join('\r\n') +
    '\r\n'
  );
}
export function datasetCsv(d: Dataset): Record<string, string> {
  return {
    'trials.csv': table(
      d.trials.map((t) => ({ ...t.input, userId: t.userId, recordedAt: t.recordedAt })),
      [
        'id',
        'runId',
        'sessionId',
        'tagLabel',
        'boxLabel',
        'deviceId',
        'deviceModel',
        'osVersion',
        'provisioningId',
        'treatment',
        'policy',
        'scenario',
        'mode',
        'ordinal',
        'eventType',
        'userId',
        'recordedAt',
      ],
    ),
    'ground-truth.csv': table(
      d.groundTruth.map((g) => ({
        ...g.input,
        revision: g.revision,
        userId: g.userId,
        recordedAt: g.recordedAt,
      })),
      [
        'id',
        'trialId',
        'revision',
        'legitimate',
        'shouldAuthorize',
        'observedBox',
        'observedTag',
        'observedOrdinal',
        'observedAt',
        'source',
        'excluded',
        'exclusionReason',
        'userId',
        'recordedAt',
      ],
    ),
    'client-stages.csv': table(
      d.clientRecords.map((r) => ({ ...r.input, userId: r.userId, recordedAt: r.recordedAt })),
      [
        'id',
        'trialId',
        'attemptId',
        'stage',
        'observationId',
        'deviceId',
        'occurredAt',
        'clockId',
        'monotonicMs',
        'durationMs',
        'boundary',
        'code',
        'userId',
        'recordedAt',
      ],
    ),
    'observations.csv': table(
      d.observations.map((o) => ({ ...o, receipt: JSON.stringify(o.receipt) })),
      [
        'id',
        'provisioningId',
        'strategy',
        'receivedAt',
        'declaredAt',
        'deviceId',
        'userId',
        'eventType',
        'uid',
        'ndef',
        'bytesBase64',
        'receipt',
        'input',
      ],
    ),
    'decisions.csv': table(
      d.observations.flatMap((o) =>
        o.decisions.map((r) => ({ observationId: o.id, revision: r.revision, ...r.result })),
      ),
      [
        'observationId',
        'revision',
        'status',
        'accepted',
        'reason',
        'classification',
        'warnings',
        'sdm',
        'evaluatedAt',
        'cause',
      ],
    ),
    'movements.csv': table(
      d.observations.flatMap((o) => o.movements.map((m) => ({ observationId: o.id, ...m }))),
      ['observationId', 'id', 'type'],
    ),
    'server-measurements.csv': table(
      d.serverMeasurements.map((m) => ({
        ...m,
        durationMs: m.endMs - m.startMs,
        unit: 'ms',
        source: 'SERVIDOR',
      })),
      [
        'observationId',
        'revision',
        'boundary',
        'clockId',
        'startMs',
        'endMs',
        'durationMs',
        'unit',
        'source',
      ],
    ),
  };
}
