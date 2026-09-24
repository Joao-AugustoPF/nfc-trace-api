import { ProvisioningSnapshot } from './provisioning';
import { Classification, Reading, TagSnapshot } from './types';
import { ndefReference } from './values';

export function evaluateReading(
  provisioning: ProvisioningSnapshot,
  tag: TagSnapshot,
  reading: Reading,
): {
  valid: boolean;
  reason: string;
  classification: Classification;
  warnings: string[];
} {
  const warnings: string[] = [];
  if (reading.modelo && reading.modelo !== tag.model) warnings.push('MODELO_DIVERGENTE');
  if (reading.uid !== tag.uid) warnings.push('UID_DIVERGENTE');
  const valid =
    provisioning.strategy === 'UID'
      ? reading.uid === tag.uid
      : reading.ndef === ndefReference(provisioning.id);
  return {
    valid,
    reason: valid
      ? 'EVIDENCIA_IDENTIFICADA'
      : provisioning.strategy === 'UID'
        ? 'UID_DIVERGENTE'
        : 'NDEF_DIVERGENTE',
    classification: warnings.length || !valid ? 'SUSPEITO' : 'REGULAR',
    warnings,
  };
}
