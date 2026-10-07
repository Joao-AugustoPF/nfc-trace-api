import { createCipheriv } from 'node:crypto';

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
// AES-CMAC: NIST SP 800-38B, including empty/incomplete final blocks.
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
