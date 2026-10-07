// Synthetic PICC counterpart for the HTTP journal tests; never physical NFC evidence.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { aesCmac } from '../src/platform/cryptography/aes-cmac';

const rot = (b: Buffer) => Buffer.concat([b.subarray(1), b.subarray(0, 1)]);
const le = (value: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(value);
  return b;
};
const trunc = (b: Buffer) => Buffer.from([1, 3, 5, 7, 9, 11, 13, 15].map((i) => b[i]!));
function cbc(key: Buffer, data: Buffer, decrypt = false, iv: Buffer = Buffer.alloc(16)): Buffer {
  const cipher = decrypt
    ? createDecipheriv('aes-128-cbc', key, iv)
    : createCipheriv('aes-128-cbc', key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}
export class SyntheticInspectionPicc {
  private slot = 0;
  private nonFirst = false;
  private b = Buffer.alloc(16);
  private ti = randomBytes(4);
  private enc: Buffer = Buffer.alloc(16);
  private mac: Buffer = Buffer.alloc(16);
  private counter = 0;
  constructor(
    readonly keys: Uint8Array,
    readonly versions: number[],
    readonly uid: string,
  ) {}
  respond(apduHex: string): string {
    const apdu = Buffer.from(apduHex, 'hex');
    const cmd = apdu[1]!;
    const data = apdu.length === 5 ? Buffer.alloc(0) : apdu.subarray(5, -1);
    if (![0x71, 0x77, 0xaf, 0x51, 0xf5, 0x64].includes(cmd))
      throw new Error('Inspection attempted a mutation or unknown instruction');
    if (cmd === 0x71 || cmd === 0x77) {
      this.slot = data[0]!;
      this.nonFirst = cmd === 0x77;
      this.b = randomBytes(16);
      return Buffer.concat([
        cbc(Buffer.from(this.keys.subarray(this.slot * 16, this.slot * 16 + 16)), this.b),
        Buffer.from('91AF', 'hex'),
      ]).toString('hex');
    }
    if (cmd === 0xaf) {
      const key = Buffer.from(this.keys.subarray(this.slot * 16, this.slot * 16 + 16));
      const plain = cbc(key, data, true);
      if (!plain.subarray(16).equals(rot(this.b))) return '91AE';
      const a = plain.subarray(0, 16);
      const mixed = Buffer.from(a.subarray(2, 8).map((x, i) => x ^ this.b[i]!));
      const suffix = Buffer.concat([
        a.subarray(0, 2),
        mixed,
        this.b.subarray(6, 16),
        a.subarray(8, 16),
      ]);
      this.enc = aesCmac(key, Buffer.concat([Buffer.from('A55A00010080', 'hex'), suffix]));
      this.mac = aesCmac(key, Buffer.concat([Buffer.from('5AA500010080', 'hex'), suffix]));
      if (!this.nonFirst) {
        this.counter = 0;
        this.ti = randomBytes(4);
      }
      const answer = this.nonFirst ? rot(a) : Buffer.concat([this.ti, rot(a), Buffer.alloc(12)]);
      return Buffer.concat([cbc(key, answer), Buffer.from('9100', 'hex')]).toString('hex');
    }
    const header = data.subarray(0, -8);
    const expected = trunc(
      aesCmac(this.mac, Buffer.concat([Buffer.from([cmd]), le(this.counter), this.ti, header])),
    );
    if (!expected.equals(data.subarray(-8)))
      throw new Error('Invalid protected command MAC/counter');
    this.counter++;
    let payload: Buffer;
    if (cmd === 0x51) {
      const padded = Buffer.alloc(16);
      Buffer.from(this.uid, 'hex').copy(padded);
      padded[7] = 0x80;
      const iv = cbc(
        this.enc,
        Buffer.concat([Buffer.from('5AA5', 'hex'), this.ti, le(this.counter), Buffer.alloc(8)]),
      );
      payload = cbc(this.enc, padded, false, iv);
    } else if (cmd === 0xf5) payload = Buffer.from('0000E0EE000100', 'hex');
    else payload = Buffer.from([this.versions[header[0]!]!]);
    const mac = trunc(
      aesCmac(this.mac, Buffer.concat([Buffer.from([0]), le(this.counter), this.ti, payload])),
    );
    return Buffer.concat([payload, mac, Buffer.from('9100', 'hex')]).toString('hex');
  }
}
