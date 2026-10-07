export const SCENARIOS = [
  'LEGITIMO_ONLINE',
  'LEGITIMO_OFFLINE',
  'DUPLICACAO',
  'CONCORRENCIA',
  'RESPOSTA_PERDIDA',
  'REORDENACAO',
  'NDEF_COPIADO',
  'UID_DIVERGENTE',
  'BYTES_ALTERADOS',
  'CONTEXTO_ALTERADO',
  'SDM_REUTILIZADO',
  'PRIMEIRA_APRESENTACAO_TARDIA',
  'TRANSFERENCIA_ETIQUETA',
] as const;
export type Scenario = (typeof SCENARIOS)[number];
export const CLIENT_STAGES = [
  'TENTATIVA_INICIADA',
  'LEITURA_OK',
  'LEITURA_FALHOU',
  'LEITURA_INTERROMPIDA',
  'CAPTURA_LOCAL',
  'CONFIRMACAO_LOCAL',
  'CONFIRMACAO_FINAL',
  'ENVIO_INICIADO',
  'ENVIO_CONFIRMADO',
  'ENVIO_FALHOU',
  'COMUNICACAO_LIBERADA',
  'DECISAO_CONSULTADA',
  'RECONCILIACAO_CONCLUIDA',
] as const;
export type ClientStage = (typeof CLIENT_STAGES)[number];
export type Treatment = 'UID' | 'NDEF_ESTATICO' | 'SDM';
export interface RunInput {
  id: string;
  name: string;
  dataKind: 'SINTETICO' | 'FISICO';
  protocolVersion: string;
  apiVersion: string;
  mobileVersion: string;
  configuration: {
    tagModel: string;
    antenna: string;
    position: string;
    surface: string;
    phoneCase: string;
    timeoutMs: number;
  };
}
export interface TrialInput {
  id: string;
  runId: string;
  sessionId: string;
  tagLabel: string;
  boxLabel: string;
  deviceId: string;
  deviceModel: string;
  osVersion: string;
  provisioningId: string;
  treatment: Treatment;
  policy: 'ESTRITA' | 'REGISTRO_TARDIO' | null;
  scenario: Scenario;
  mode: 'LEITURA_FISICA' | 'REEXECUCAO' | 'SINTETICA';
  ordinal: number;
  eventType: string;
}
export interface GroundTruthInput {
  id: string;
  trialId: string;
  legitimate: boolean;
  shouldAuthorize: boolean;
  observedBox: string;
  observedTag: string;
  observedOrdinal: number;
  observedAt: string;
  source: 'OBSERVADOR' | 'ROTEIRO_SINTETICO';
  excluded: boolean;
  exclusionReason:
    | 'NAO_EXCLUIDA'
    | 'CONFIGURACAO_DIVERGENTE'
    | 'PROCEDIMENTO_INTERROMPIDO'
    | 'HARDWARE_INCOMPATIVEL';
}
export interface ClientRecordInput {
  id: string;
  trialId: string;
  attemptId: string;
  stage: ClientStage;
  observationId: string | null;
  deviceId: string;
  occurredAt: string;
  clockId: string;
  monotonicMs: number;
  durationMs: number | null;
  boundary:
    | 'INSTANTE'
    | 'SESSAO_NFC_ATE_EVIDENCIA'
    | 'ENVIO_ATE_RESPOSTA'
    | 'LIBERACAO_ATE_DECISAO_FINAL'
    | 'INICIO_ATE_CONFIRMACAO_LOCAL'
    | 'INICIO_ATE_DECISAO_FINAL';
  code: string | null;
}
export interface Stored<T> {
  input: T;
  recordedAt: string;
  userId: string;
}
export interface GroundTruthRecord extends Stored<GroundTruthInput> {
  revision: number;
}
export interface ExportObservation {
  id: string;
  provisioningId: string;
  strategy: string | null;
  receivedAt: string;
  declaredAt: string;
  deviceId: string;
  userId: string | null;
  eventType: string;
  uid: string;
  ndef: string | null;
  bytesBase64: string | null;
  receipt: Record<string, unknown>;
  decisions: { revision: number; result: Record<string, unknown> }[];
  movements: { id: string; type: string }[];
  input: Record<string, unknown>;
}
export interface ServerMeasurement {
  observationId: string;
  revision: number;
  boundary: string;
  clockId: string;
  startMs: number;
  endMs: number;
}
export interface Dataset {
  schemaVersion: 1;
  run: Stored<RunInput>;
  trials: Stored<TrialInput>[];
  groundTruth: GroundTruthRecord[];
  clientRecords: Stored<ClientRecordInput>[];
  observations: ExportObservation[];
  serverMeasurements: ServerMeasurement[];
}
