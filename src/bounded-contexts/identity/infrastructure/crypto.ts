import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { Passwords, Tokens } from '../application/ports';

export class ScryptPasswords implements Passwords {
  private derive(password: string, salt: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      scrypt(
        password,
        salt,
        64,
        { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 },
        (error, key) => (error ? reject(error) : resolve(key)),
      );
    });
  }
  async hash(password: string) {
    const salt = randomBytes(16).toString('hex');
    return ['scrypt-v1', salt, (await this.derive(password, salt)).toString('hex')].join('$');
  }
  async verify(password: string, encoded: string) {
    const [scheme, salt, key] = encoded.split('$');
    if (
      scheme !== 'scrypt-v1' ||
      !salt ||
      !/^[a-f0-9]{32}$/.test(salt) ||
      !key ||
      !/^[a-f0-9]{128}$/.test(key)
    )
      return false;
    return timingSafeEqual(await this.derive(password, salt), Buffer.from(key, 'hex'));
  }
  dummyHash() {
    // A syntactically valid, non-account hash keeps unknown logins on the same KDF path.
    return Promise.resolve('scrypt-v1$' + '0'.repeat(32) + '$' + '0'.repeat(128));
  }
}
export class OpaqueTokens implements Tokens {
  issue() {
    return 'nfc_' + randomBytes(32).toString('base64url');
  }
  digest(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }
}
