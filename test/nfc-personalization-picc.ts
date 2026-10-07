// Stateful synthetic counterpart; checks command MACs, access rights, encrypted writes and key CRC.
// It is test evidence only, never a certificate of physical NTAG behavior.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { aesCmac } from '../src/platform/cryptography/aes-cmac';
const rot = (b: Buffer) => Buffer.concat([b.subarray(1), b.subarray(0, 1)]);
const le = (v: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v);
  return b;
};
const trunc = (b: Buffer) => Buffer.from([1, 3, 5, 7, 9, 11, 13, 15].map((i) => b[i]!));
function cbc(key: Buffer, data: Buffer, iv: Buffer = Buffer.alloc(16), decrypt = false): Buffer {
  const c = decrypt
    ? createDecipheriv('aes-128-cbc', key, iv)
    : createCipheriv('aes-128-cbc', key, iv);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(data), c.final()]);
}
function pad(data: Buffer): Buffer {
  const b = Buffer.alloc((Math.floor(data.length / 16) + 1) * 16);
  data.copy(b);
  b[data.length] = 128;
  return b;
}
function unpad(b: Buffer): Buffer {
  let i = b.length - 1;
  while (b[i] === 0) i--;
  if (b[i] !== 128) throw Error('Bad padding');
  return b.subarray(0, i);
}
function crc(b: Buffer): Buffer {
  let c = 0xffffffff;
  for (const x of b) {
    c ^= x;
    for (let n = 0; n < 8; n++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  const r = Buffer.alloc(4);
  r.writeUInt32LE(c >>> 0);
  return r;
}
export class SyntheticPersonalizationPicc {
  readonly keys: Buffer;
  readonly versions: number[];
  readonly files = new Map<number, Buffer>([
    [
      1,
      Buffer.concat([
        Buffer.from('001720010000FF0406E104010000000506E10500808283', 'hex'),
        Buffer.alloc(9),
      ]),
    ],
    [2, Buffer.alloc(256)],
  ]);
  readonly settings = new Map<number, Buffer>([
    [1, Buffer.from('000000E0200000', 'hex')],
    [2, Buffer.from('0000E0EE000100', 'hex')],
  ]);
  readonly mutations: number[] = [];
  sdmCounterResets = 0;
  private slot = 0;
  private b = Buffer.alloc(16);
  private nonFirst = false;
  private ti = randomBytes(4);
  private counter = 0;
  private enc: Buffer = Buffer.alloc(16);
  private mac: Buffer = Buffer.alloc(16);
  private authenticated = false;
  constructor(
    keys: Uint8Array,
    versions: number[],
    readonly uid: string,
  ) {
    this.keys = Buffer.from(keys);
    this.versions = [...versions];
  }
  private iv(reply = false): Buffer {
    return cbc(
      this.enc,
      Buffer.concat([
        Buffer.from(reply ? '5AA5' : 'A55A', 'hex'),
        this.ti,
        le(this.counter),
        Buffer.alloc(8),
      ]),
    );
  }
  respond(apduHex: string): string {
    const apdu = Buffer.from(apduHex, 'hex'),
      cmd = apdu[1]!,
      data = apdu.subarray(5, -1);
    if (apdu.length > 128) throw Error('Native command may require frame chaining');
    if (cmd === 0x71 || cmd === 0x77) {
      if (cmd === 0x77 && !this.authenticated) return '919D';
      this.slot = data[0]!;
      this.nonFirst = cmd === 0x77;
      this.b = randomBytes(16);
      return Buffer.concat([
        cbc(this.keys.subarray(this.slot * 16, this.slot * 16 + 16), this.b),
        Buffer.from('91AF', 'hex'),
      ]).toString('hex');
    }
    if (cmd === 0xaf) {
      const key = this.keys.subarray(this.slot * 16, this.slot * 16 + 16),
        plain = cbc(key, data, Buffer.alloc(16), true);
      if (!plain.subarray(16).equals(rot(this.b))) {
        this.authenticated = false;
        return '91AE';
      }
      const a = plain.subarray(0, 16),
        mix = Buffer.from(a.subarray(2, 8).map((v, i) => v ^ this.b[i]!));
      const suffix = Buffer.concat([a.subarray(0, 2), mix, this.b.subarray(6), a.subarray(8)]);
      this.enc = aesCmac(key, Buffer.concat([Buffer.from('A55A00010080', 'hex'), suffix]));
      this.mac = aesCmac(key, Buffer.concat([Buffer.from('5AA500010080', 'hex'), suffix]));
      if (!this.nonFirst) {
        this.counter = 0;
        this.ti = randomBytes(4);
      }
      this.authenticated = true;
      const answer = this.nonFirst ? rot(a) : Buffer.concat([this.ti, rot(a), Buffer.alloc(12)]);
      return Buffer.concat([cbc(key, answer), Buffer.from('9100', 'hex')]).toString('hex');
    }
    if (!this.authenticated) return '919D';
    const body = data.subarray(0, -8),
      expected = trunc(
        aesCmac(this.mac, Buffer.concat([Buffer.from([cmd]), le(this.counter), this.ti, body])),
      );
    if (!expected.equals(data.subarray(-8))) throw Error('Invalid command MAC/counter');
    const headerLength = [0xad, 0x8d].includes(cmd) ? 7 : cmd === 0x51 ? 0 : 1;
    const header = body.subarray(0, headerLength),
      payload = body.subarray(headerLength);
    const decrypted = [0x8d, 0x5f, 0xc4].includes(cmd)
      ? unpad(cbc(this.enc, payload, this.iv(), true))
      : Buffer.alloc(0);
    let answer: Buffer = Buffer.alloc(0),
      full = false;
    const file = header[0]!,
      settings = this.settings.get(file);
    if (cmd === 0x51) {
      answer = Buffer.from(this.uid, 'hex');
      full = true;
    } else if (cmd === 0x64) answer = Buffer.from([this.versions[file]!]);
    else if (cmd === 0xf5) answer = Buffer.from(settings!);
    else if (cmd === 0xad || cmd === 0x8d) {
      if (!settings) throw Error('Unknown file');
      const offset = header.readUIntLE(1, 3),
        length = header.readUIntLE(4, 3),
        image = this.files.get(file)!;
      const rw = settings[2]! >>> 4,
        access = cmd === 0xad ? settings[3]! >>> 4 : settings[3]! & 15;
      if (rw !== this.slot && access !== this.slot)
        throw Error('Protected access denied (free E requires Plain mode)');
      if ((settings[1]! & 3) !== 3) throw Error('File is not Full');
      if (offset + length > image.length) throw Error('Range exceeded');
      if (cmd === 0xad) {
        answer = Buffer.from(image.subarray(offset, offset + length));
        full = true;
      } else {
        if (decrypted.length !== length) throw Error('Write length');
        decrypted.copy(image, offset);
        this.mutations.push(cmd);
      }
    } else if (cmd === 0x5f) {
      if (this.slot !== 0 || !settings || (settings[2]! & 15) !== 0)
        throw Error('Change settings denied');
      const updated = Buffer.concat([
        Buffer.from([0]),
        decrypted.subarray(0, 3),
        settings.subarray(4, 7),
        decrypted.subarray(3),
      ]);
      if (updated[1]! & 0x40) this.sdmCounterResets++;
      this.settings.set(file, updated);
      this.mutations.push(cmd);
    } else if (cmd === 0xc4) {
      if (this.slot !== 0) throw Error('Change key denied');
      const slot = file;
      const next =
        slot === 0
          ? decrypted.subarray(0, 16)
          : Buffer.from(decrypted.subarray(0, 16).map((v, i) => v ^ this.keys[slot * 16 + i]!));
      if (slot !== 0 && !crc(next).equals(decrypted.subarray(17)))
        throw Error('New key CRC invalid');
      next.copy(this.keys, slot * 16);
      this.versions[slot] = decrypted[16]!;
      this.mutations.push(cmd);
      if (slot === 0) {
        this.authenticated = false;
        return '9100';
      }
    } else throw Error('Unsupported command');
    this.counter++;
    if (full) answer = cbc(this.enc, pad(answer), this.iv(true));
    const mac = trunc(
      aesCmac(this.mac, Buffer.concat([Buffer.from([0]), le(this.counter), this.ti, answer])),
    );
    return Buffer.concat([answer, mac, Buffer.from('9100', 'hex')]).toString('hex');
  }
}
