import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { DomainError } from '../../../shared-kernel/domain-error';
import { SealedSdmKeys, SdmCryptography } from '../application/sdm-ports';
import { SdmConfiguration, sdmUri } from '../domain/sdm';
import { Reading } from '../domain/types';

function encryptBlock(key: Buffer, block: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(block), cipher.final()]);
}
function xor(a: Buffer, b: Buffer): Buffer {
  return Buffer.from(a.map((byte, i) => byte ^ b[i]!));
}
function double(block: Buffer): Buffer {
  const result = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) result[i] = ((block[i]! << 1) | ((block[i + 1] ?? 0) >>> 7)) & 255;
  if (block[0]! & 128) result[15] = result[15]! ^ 0x87;
  return result;
}
// AES-CMAC: NIST SP 800-38B, including the empty and incomplete final block cases.
export function aesCmac(key: Buffer, message: Buffer): Buffer {
  const k1 = double(encryptBlock(key, Buffer.alloc(16)));
  const k2 = double(k1);
  const blocks = Math.max(1, Math.ceil(message.length / 16));
  const complete = message.length > 0 && message.length % 16 === 0;
  const last = Buffer.alloc(16);
  message.copy(last, 0, (blocks - 1) * 16);
  if (!complete) last[message.length % 16] = 0x80;
  let state: Buffer = Buffer.alloc(16);
  for (let i = 0; i < blocks - 1; i++)
    state = encryptBlock(key, xor(state, message.subarray(i * 16, i * 16 + 16)));
  return encryptBlock(key, xor(state, xor(last, complete ? k1 : k2)));
}
export function deriveSdmKey(
  key: Buffer,
  uid: Buffer,
  counterLE: Buffer,
  prefix = '3CC300010080',
): Buffer {
  return aesCmac(key, Buffer.concat([Buffer.from(prefix, 'hex'), uid, counterLE]));
}
export function truncateSdmMac(mac: Buffer): Buffer {
  return Buffer.from([1, 3, 5, 7, 9, 11, 13, 15].map((i) => mac[i]!));
}
export function decryptPicc(key: Buffer, encrypted: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16));
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}
export function sdmMessage(uri: string): Buffer {
  return Buffer.concat([Buffer.from([0xd1, 1, 123, 0x55, 0]), Buffer.from(uri, 'ascii')]);
}

export class NodeSdmCryptography implements SdmCryptography {
  private readonly masters = new Map<string, Buffer>();
  constructor(
    private readonly activeVersion?: string,
    keyringJson?: string,
  ) {
    if (!activeVersion && !keyringJson) return;
    try {
      const parsed: unknown = JSON.parse(keyringJson ?? '');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      for (const [version, value] of Object.entries(parsed)) {
        if (!/^[1-9][0-9]{0,8}$/.test(version) || typeof value !== 'string') throw new Error();
        const key = Buffer.from(value, 'base64');
        if (key.length !== 32 || key.toString('base64') !== value) throw new Error();
        this.masters.set(version, key);
      }
      if (!this.masters.has(activeVersion ?? '')) throw new Error();
    } catch {
      throw new Error('Invalid SDM vault configuration');
    }
  }
  private master(version: string | undefined): Buffer {
    const key = this.masters.get(version ?? '');
    if (!key)
      throw new DomainError(
        'SDM_CHAVES_INDISPONIVEIS',
        'Cofre SDM indisponível; tente novamente após recuperar a configuração do servidor.',
        'unavailable',
      );
    return key;
  }
  private aad(id: string, config: SdmConfiguration, version: string): Buffer {
    return Buffer.from(
      JSON.stringify([id, config.profile, config.keyReference, config.keyVersion, version]),
    );
  }
  private seal(id: string, config: SdmConfiguration, plain: Buffer): SealedSdmKeys {
    const version = this.activeVersion!;
    const nonce = randomBytes(12);
    const actual = createCipheriv('aes-256-gcm', this.master(version), nonce);
    actual.setAAD(this.aad(id, config, version));
    const ciphertext = Buffer.concat([actual.update(plain), actual.final()]);
    return {
      masterVersion: version,
      nonce: nonce.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      authenticationTag: actual.getAuthTag().toString('base64'),
    };
  }
  generate(id: string, config: SdmConfiguration): SealedSdmKeys {
    this.master(this.activeVersion);
    const keys = randomBytes(32);
    try {
      return this.seal(id, config, keys);
    } finally {
      keys.fill(0);
    }
  }
  // Restricted local administration uses this adapter, never a public HTTP response.
  unseal(id: string, config: SdmConfiguration, keys: SealedSdmKeys): Buffer {
    const master = this.master(keys.masterVersion);
    try {
      const nonce = Buffer.from(keys.nonce, 'base64');
      const tag = Buffer.from(keys.authenticationTag, 'base64');
      if (nonce.length !== 12 || tag.length !== 16) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', master, nonce);
      decipher.setAAD(this.aad(id, config, keys.masterVersion));
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([
        decipher.update(Buffer.from(keys.ciphertext, 'base64')),
        decipher.final(),
      ]);
      if (plain.length !== 32) throw new Error();
      return plain;
    } catch {
      throw new DomainError(
        'SDM_CHAVES_INDISPONIVEIS',
        'Não foi possível recuperar as chaves SDM do servidor.',
        'unavailable',
      );
    }
  }
  rewrap(id: string, config: SdmConfiguration, keys: SealedSdmKeys): SealedSdmKeys {
    const plain = this.unseal(id, config, keys);
    try {
      return this.seal(id, config, plain);
    } finally {
      plain.fill(0);
    }
  }
  verify(
    id: string,
    config: SdmConfiguration,
    expectedUid: string,
    reading: Reading,
    keys: SealedSdmKeys,
  ) {
    const invalid = { valid: false, counter: null };
    const uri = reading.ndef;
    const match = uri?.match(
      /^urn:nfc-trace:sdm:v1:([0-9a-f-]{36})\?picc_data=([0-9a-fA-F]{32})&cmac=([0-9a-fA-F]{16})$/,
    );
    if (!match || match[1] !== id || !reading.bytesBase64 || !/^[0-9A-F]{14}$/.test(expectedUid))
      return invalid;
    const bytes = Buffer.from(reading.bytesBase64, 'base64');
    if (
      bytes.toString('base64') !== reading.bytesBase64 ||
      !bytes.equals(sdmMessage(uri!)) ||
      bytes.length !== sdmMessage(sdmUri(id)).length
    )
      return invalid;
    const plainKeys = this.unseal(id, config, keys);
    try {
      const picc = decryptPicc(plainKeys.subarray(0, 16), Buffer.from(match[2]!, 'hex'));
      const uid = picc.subarray(1, 8);
      const counter = picc.subarray(8, 11);
      const session = deriveSdmKey(plainKeys.subarray(16), uid, counter);
      const expectedMac = truncateSdmMac(aesCmac(session, bytes.subarray(5, 111)));
      const macValid = timingSafeEqual(expectedMac, Buffer.from(match[3]!, 'hex'));
      const uidValid = timingSafeEqual(uid, Buffer.from(expectedUid, 'hex'));
      if (!macValid || !uidValid || picc[0] !== 0xc7) return invalid;
      return { valid: true, counter: counter.readUIntLE(0, 3) };
    } finally {
      plainKeys.fill(0);
    }
  }
}
