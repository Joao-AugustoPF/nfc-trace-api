export const SDM_PROFILE = 'nfc-trace.sdm.encrypted-picc.v1' as const;
export const SDM_POLICIES = ['ESTRITA', 'REGISTRO_TARDIO'] as const;
export type SdmPolicy = (typeof SDM_POLICIES)[number];

// Only references are part of the aggregate. Key material belongs to the vault adapter.
export interface SdmConfiguration {
  profile: typeof SDM_PROFILE;
  policy: SdmPolicy;
  keyReference: string;
  keyVersion: 1;
}
export interface SdmDecision {
  perfil: typeof SDM_PROFILE;
  politica: SdmPolicy;
  epoca: number;
  autenticada: boolean;
  previamenteUtilizada: boolean;
  contador: number | null;
  maiorContadorAnterior: number | null;
  temporalidade: 'NAO_AVALIADA' | 'NOVA' | 'TARDIA' | 'REUTILIZADA';
}
export function sdmUri(id: string): string {
  return `urn:nfc-trace:sdm:v1:${id}?picc_data=${'0'.repeat(32)}&cmac=${'0'.repeat(16)}`;
}
export function evaluateSdmCounter(
  policy: SdmPolicy,
  counter: number,
  maximum: number,
  used: boolean,
) {
  if (used)
    return { eligible: false, reason: 'SDM_EVIDENCIA_REUTILIZADA', timing: 'REUTILIZADA' as const };
  if (counter <= maximum)
    return {
      eligible: false,
      reason: policy === 'ESTRITA' ? 'SDM_CONTADOR_NAO_CRESCENTE' : 'SDM_REGISTRO_TARDIO',
      timing: 'TARDIA' as const,
    };
  return { eligible: true, reason: 'SDM_AUTENTICADA', timing: 'NOVA' as const };
}
