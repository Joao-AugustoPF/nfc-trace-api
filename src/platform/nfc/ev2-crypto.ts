import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { aesCmac } from '../cryptography/aes-cmac';

export interface Ev2Cryptography {
  random16(): Uint8Array;
  encrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array;
  decrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array;
  cmac(key: Uint8Array, data: Uint8Array): Uint8Array;
  equal(a: Uint8Array, b: Uint8Array): boolean;
}

// Server adapter only. Keys are never distributed to the React Native bundle.
export class NodeEv2Cryptography implements Ev2Cryptography {
  random16(): Uint8Array {
    return randomBytes(16);
  }
  encrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
    const cipher = createCipheriv('aes-128-cbc', key, iv);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(data), cipher.final()]);
  }
  decrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
    const cipher = createDecipheriv('aes-128-cbc', key, iv);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(data), cipher.final()]);
  }
  cmac(key: Uint8Array, data: Uint8Array): Uint8Array {
    return aesCmac(
      Buffer.from(key.buffer, key.byteOffset, key.byteLength),
      Buffer.from(data.buffer, data.byteOffset, data.byteLength),
    );
  }
  equal(a: Uint8Array, b: Uint8Array): boolean {
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
