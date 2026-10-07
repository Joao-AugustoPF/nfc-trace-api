import { DomainError } from '../../../shared-kernel/domain-error';
import { ClientRecordInput, GroundTruthInput, RunInput, TrialInput } from './types';

export function assertTrial(
  run: RunInput,
  trial: TrialInput,
  actual: { strategy: string; policy: string | null },
) {
  if (trial.treatment !== actual.strategy || trial.policy !== actual.policy)
    throw new DomainError(
      'TRATAMENTO_DIVERGENTE',
      'O tratamento/política precisa corresponder ao vínculo planejado.',
    );
  if ((run.dataKind === 'SINTETICO') !== (trial.mode === 'SINTETICA'))
    throw new DomainError(
      'ORIGEM_EXPERIMENTAL_DIVERGENTE',
      'Separe fixtures sintéticas de leituras físicas e reexecuções.',
    );
}
export function assertGroundTruth(run: RunInput, truth: GroundTruthInput) {
  if (
    (run.dataKind === 'SINTETICO') !== (truth.source === 'ROTEIRO_SINTETICO') ||
    truth.excluded === (truth.exclusionReason === 'NAO_EXCLUIDA')
  )
    throw new DomainError(
      'GROUND_TRUTH_INVALIDO',
      'Confira origem e justificativa independente da exclusão.',
    );
}
export function assertClientRecord(trial: TrialInput, record: ClientRecordInput) {
  const timed: Partial<Record<ClientRecordInput['stage'], ClientRecordInput['boundary']>> = {
    LEITURA_OK: 'SESSAO_NFC_ATE_EVIDENCIA',
    LEITURA_FALHOU: 'SESSAO_NFC_ATE_EVIDENCIA',
    ENVIO_CONFIRMADO: 'ENVIO_ATE_RESPOSTA',
    ENVIO_FALHOU: 'ENVIO_ATE_RESPOSTA',
    RECONCILIACAO_CONCLUIDA: 'LIBERACAO_ATE_DECISAO_FINAL',
    CONFIRMACAO_LOCAL: 'INICIO_ATE_CONFIRMACAO_LOCAL',
    CONFIRMACAO_FINAL: 'INICIO_ATE_DECISAO_FINAL',
  };
  if (
    record.deviceId !== trial.deviceId ||
    record.boundary !== (timed[record.stage] ?? 'INSTANTE') ||
    (!timed[record.stage] && record.durationMs !== null)
  )
    throw new DomainError('MEDICAO_INVALIDA', 'Confira aparelho, estágio e fronteira da medição.');
  if (
    [
      'CAPTURA_LOCAL',
      'CONFIRMACAO_LOCAL',
      'CONFIRMACAO_FINAL',
      'ENVIO_INICIADO',
      'ENVIO_CONFIRMADO',
      'ENVIO_FALHOU',
      'DECISAO_CONSULTADA',
      'RECONCILIACAO_CONCLUIDA',
    ].includes(record.stage) &&
    !record.observationId
  )
    throw new DomainError(
      'CAPTURA_EXPERIMENTAL_AUSENTE',
      'Este estágio exige o UUID original da captura.',
    );
}
