import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { CredentialRecord, CredentialVault, SealedCredentials } from '../application/ports';
import { DomainError } from '../../../shared-kernel/domain-error';

export class NodeCredentialVault implements CredentialVault {
  #masters = new Map<string, Buffer>();
  constructor(
    private readonly activeVersion?: string,
    keyringJson?: string,
  ) {
    if (!activeVersion && !keyringJson) return;
    try {
      const ring: unknown = JSON.parse(keyringJson ?? '');
      if (!ring || typeof ring !== 'object' || Array.isArray(ring)) throw new Error();
      for (const [version, encoded] of Object.entries(ring)) {
        if (!/^[1-9][0-9]{0,8}$/.test(version) || typeof encoded !== 'string') throw new Error();
        const key = Buffer.from(encoded, 'base64');
        if (key.length !== 32 || key.toString('base64') !== encoded) throw new Error();
        this.#masters.set(version, key);
      }
      if (!this.#masters.has(activeVersion ?? '')) throw new Error();
    } catch {
      this.close();
      throw new Error('Invalid NFC administration vault configuration');
    }
  }
  private unavailable(): DomainError {
    return new DomainError(
      'NFC_COFRE_INDISPONIVEL',
      'Recupere a configuração privada do cofre antes de continuar.',
      'unavailable',
    );
  }
  private master(version?: string): Buffer {
    const key = this.#masters.get(version ?? '');
    if (!key) throw this.unavailable();
    return key;
  }
  private aad(id: string, uid: string, versions: number[], masterVersion: string): Buffer {
    // Different purpose/AAD from the SDM vault, even when sharing the wrapping keyring.
    return Buffer.from(
      JSON.stringify(['nfc-administration.credentials.v1', id, uid, versions, masterVersion]),
    );
  }
  seal(id: string, uid: string, versions: number[], keys: Uint8Array): SealedCredentials {
    if (keys.length !== 80)
      throw new DomainError(
        'NFC_INVENTARIO_INVALIDO',
        'São necessárias cinco chaves AES de 16 bytes.',
      );
    const nonce = randomBytes(12);
    const version = this.activeVersion!;
    const cipher = createCipheriv('aes-256-gcm', this.master(version), nonce);
    cipher.setAAD(this.aad(id, uid, versions, version));
    const encrypted = Buffer.concat([cipher.update(keys), cipher.final()]);
    return {
      masterVersion: version,
      nonce: nonce.toString('base64'),
      ciphertext: encrypted.toString('base64'),
      authenticationTag: cipher.getAuthTag().toString('base64'),
    };
  }
  unseal(record: CredentialRecord): Uint8Array {
    try {
      const { sealed } = record;
      const nonce = Buffer.from(sealed.nonce, 'base64');
      const tag = Buffer.from(sealed.authenticationTag, 'base64');
      const ciphertext = Buffer.from(sealed.ciphertext, 'base64');
      if (nonce.length !== 12 || tag.length !== 16 || ciphertext.length !== 80) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', this.master(sealed.masterVersion), nonce);
      decipher.setAAD(this.aad(record.id, record.uid, record.versions, sealed.masterVersion));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw this.unavailable();
    }
  }
  rewrap(record: CredentialRecord): SealedCredentials {
    const plain = this.unseal(record);
    try {
      return this.seal(record.id, record.uid, record.versions, plain);
    } finally {
      plain.fill(0);
    }
  }
  close(): void {
    for (const key of this.#masters.values()) key.fill(0);
    this.#masters.clear();
  }
}
