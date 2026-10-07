import { DomainError } from '../../../shared-kernel/domain-error';

export const PERSONALIZATION_PROFILE = 'nfc-trace.personalization.v1' as const;
export interface PersonalizationPlan {
  profile: typeof PERSONALIZATION_PROFILE;
  targetReference: string;
  targetVersions: number[];
  ndefImageHex: string;
  ccImageHex: string;
  finalNdefSettingsHex: string;
  finalCcSettingsHex: string;
  sdmProfile: string | null;
}
const hex = (bytes: readonly number[]) =>
  bytes
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
/** Fixed, recoverable layout. No client-supplied offsets, permissions or commands. */
export function personalizationPlan(
  id: string,
  strategy: string,
  reference: string,
  versions: number[],
): PersonalizationPlan {
  if (!/^[0-9a-f-]{36}$/.test(id) || !['UID', 'NDEF_ESTATICO', 'SDM'].includes(strategy))
    throw new DomainError('NFC_PLANO_INVALIDO', 'O vínculo não possui tratamento disponível.');
  const uri =
    strategy === 'UID'
      ? null
      : strategy === 'NDEF_ESTATICO'
        ? `urn:nfc-trace:provisioning:${id}`
        : `urn:nfc-trace:sdm:v1:${id}?picc_data=${'0'.repeat(32)}&cmac=${'0'.repeat(16)}`;
  const message = uri
    ? [0xd1, 1, uri.length + 1, 0x55, 0, ...[...uri].map((c) => c.charCodeAt(0))]
    : [];
  const image = Array<number>(256).fill(0);
  image[0] = Math.floor(message.length / 256);
  image[1] = message.length % 256;
  image.splice(2, message.length, ...message);
  const cc = [
    0,
    23,
    0x20,
    1,
    0,
    0,
    0xff,
    4,
    6,
    0xe1,
    4,
    1,
    0,
    0,
    0xff,
    5,
    6,
    0xe1,
    5,
    0,
    0x80,
    0x82,
    0x83,
    ...Array<number>(9).fill(0),
  ];
  const sdm = strategy === 'SDM';
  return {
    profile: PERSONALIZATION_PROFILE,
    targetReference: reference,
    targetVersions: [...versions],
    ndefImageHex: hex(image),
    ccImageHex: hex(cc),
    finalNdefSettingsHex: sdm ? '0043F0E0000100C1FF124B0000070000710000' : '0003F0E0000100',
    finalCcSettingsHex: '000300E0200000',
    sdmProfile: sdm ? 'nfc-trace.sdm.encrypted-picc.v1' : null,
  };
}
export function changeSettingsPayload(settingsHex: string): string {
  // GetFileSettings includes file type/size; ChangeFileSettings does not.
  return settingsHex.slice(2, 8) + settingsHex.slice(14);
}
export type MaterialChoice = 'ATUAL' | 'ALVO';
