import { DomainError } from '../../../shared-kernel/domain-error';

export function normalizeUid(value: string): string {
  const normalized = value.replace(/[:\s-]/g, '').toUpperCase();
  if (!/^(?:[0-9A-F]{2}){4,10}$/.test(normalized)) {
    throw new DomainError('UID_INVALIDO', 'UID deve conter de 4 a 10 bytes em hexadecimal.');
  }
  return normalized;
}

export function normalizeOrderCode(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{0,63}$/.test(normalized)) {
    throw new DomainError('CODIGO_PEDIDO_INVALIDO', 'Código do pedido inválido.');
  }
  return normalized;
}

export function ndefReference(provisioningId: string): string {
  return `urn:nfc-trace:provisioning:${provisioningId}`;
}
