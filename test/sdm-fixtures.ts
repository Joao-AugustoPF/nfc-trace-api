import { createCipheriv, randomBytes } from 'node:crypto';
import { SdmConfiguration, sdmUri } from '../src/bounded-contexts/traceability/domain/sdm';
import {
  NodeSdmCryptography,
  aesCmac,
  deriveSdmKey,
  sdmMessage,
  truncateSdmMac,
} from '../src/bounded-contexts/traceability/infrastructure/sdm-crypto';
import { SealedSdmKeys } from '../src/bounded-contexts/traceability/application/sdm-ports';

// Synthetic NFC Trace contract fixtures. These are NOT tag captures or NXP examples.
export function syntheticSdmReading(
  vault: NodeSdmCryptography,
  id: string,
  config: SdmConfiguration,
  sealed: SealedSdmKeys,
  uid: string,
  counter: number,
  options: { wrongKey?: boolean; piccTag?: number; lowerCase?: boolean } = {},
) {
  const keys = vault.unseal(id, config, sealed);
  const ctr = Buffer.alloc(3);
  ctr.writeUIntLE(counter, 0, 3);
  const plain = Buffer.concat([
    Buffer.from([options.piccTag ?? 0xc7]),
    Buffer.from(uid, 'hex'),
    ctr,
    randomBytes(5),
  ]);
  const cipher = createCipheriv(
    'aes-128-cbc',
    options.wrongKey ? randomBytes(16) : keys.subarray(0, 16),
    Buffer.alloc(16),
  );
  cipher.setAutoPadding(false);
  const picc = Buffer.concat([cipher.update(plain), cipher.final()]).toString('hex');
  const uri = sdmUri(id).replace('0'.repeat(32), options.lowerCase ? picc : picc.toUpperCase());
  const session = deriveSdmKey(
    options.wrongKey ? randomBytes(16) : keys.subarray(16),
    Buffer.from(uid, 'hex'),
    ctr,
  );
  const mac = truncateSdmMac(aesCmac(session, sdmMessage(uri).subarray(5, 111))).toString('hex');
  const ndef = uri.slice(0, -16) + (options.lowerCase ? mac : mac.toUpperCase());
  keys.fill(0);
  return { uid, ndef, bytesBase64: sdmMessage(ndef).toString('base64') };
}
