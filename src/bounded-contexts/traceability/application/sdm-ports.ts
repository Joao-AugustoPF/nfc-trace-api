import { Reading } from '../domain/types';
import { SdmConfiguration } from '../domain/sdm';

export interface SealedSdmKeys {
  masterVersion: string;
  nonce: string;
  ciphertext: string;
  authenticationTag: string;
}
export interface SdmCryptography {
  generate(provisioningId: string, configuration: SdmConfiguration): SealedSdmKeys;
  verify(
    provisioningId: string,
    configuration: SdmConfiguration,
    expectedUid: string,
    reading: Reading,
    keys: SealedSdmKeys,
  ): { valid: boolean; counter: number | null };
}
export interface SdmRepository {
  owns(provisioningId: string, counter: number, observationId: string): Promise<boolean>;
  insertKeys(id: string, configuration: SdmConfiguration, keys: SealedSdmKeys): Promise<void>;
  keys(id: string): Promise<SealedSdmKeys>;
  reserve(
    id: string,
    counter: number,
    observationId: string | null,
  ): Promise<{ used: boolean; maximum: number }>;
}
