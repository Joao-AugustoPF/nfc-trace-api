export interface MonotonicClock {
  readonly originId: string;
  nowMs(): number;
}
export const SERVER_BOUNDARIES = [
  'VALIDACAO_EVIDENCIA',
  'PROCESSAMENTO_ANTES_COMMIT',
  'RECONCILIACAO_ANTES_COMMIT',
] as const;
export type ServerBoundary = (typeof SERVER_BOUNDARIES)[number];
export interface MeasurementWriter {
  record(
    observationId: string,
    revision: number,
    boundary: ServerBoundary,
    clock: MonotonicClock,
    startMs: number,
    endMs: number,
  ): Promise<void>;
}
