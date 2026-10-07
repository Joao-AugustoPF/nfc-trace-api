import { Ev2Cryptography } from './ev2-crypto';

export class Ev2Error extends Error {
  constructor(
    readonly code: string,
    readonly statusWord?: string,
    readonly physicalOutcome: 'NAO_APLICAVEL' | 'NAO_CONFIRMADO' = 'NAO_APLICAVEL',
  ) {
    super('Operação administrativa NFC não confirmada; confira a etapa antes de retomar.');
    this.name = 'Ev2Error';
  }
}
const bytes = (...parts: readonly Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]));
const zero = () => new Uint8Array(16);
const rotate = (input: Uint8Array) => bytes(input.slice(1), input.slice(0, 1));
function integer(value: number, maximum: number): void {
  if (!Number.isInteger(value) || value < 0 || value > maximum)
    throw new Ev2Error('NFC_ADMIN_PARAMETRO_INVALIDO');
}
export function littleEndian(value: number, length: 2 | 3): Uint8Array {
  integer(value, 2 ** (length * 8) - 1);
  return Uint8Array.from({ length }, (_, i) => (value >>> (i * 8)) & 255);
}
export function padMethod2(data: Uint8Array): Uint8Array {
  const padded = new Uint8Array((Math.floor(data.length / 16) + 1) * 16);
  padded.set(data);
  padded[data.length] = 0x80;
  return padded;
}
function unpadMethod2(data: Uint8Array): Uint8Array {
  if (!data.length || data.length % 16) throw new Ev2Error('NFC_ADMIN_PADDING_INVALIDO');
  let end = data.length - 1;
  while (end >= 0 && data[end] === 0) end--;
  if (end < data.length - 16 || data[end] !== 0x80)
    throw new Ev2Error('NFC_ADMIN_PADDING_INVALIDO');
  return Uint8Array.from(data.subarray(0, end));
}
export function mac8(mac: Uint8Array): Uint8Array {
  if (mac.length !== 16) throw new Ev2Error('NFC_ADMIN_CRIPTOGRAFIA_INVALIDA');
  return Uint8Array.from([1, 3, 5, 7, 9, 11, 13, 15].map((i) => mac[i]!));
}
export function crc32NewKey(key: Uint8Array): Uint8Array {
  let crc = 0xffffffff;
  for (const byte of key) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  // NTAG ChangeKey uses the running CRC (no final complement); AN12196 table 25.
  const result = crc >>> 0;
  return Uint8Array.from({ length: 4 }, (_, i) => (result >>> (i * 8)) & 255);
}
export function sessionKeys(
  crypto: Ev2Cryptography,
  key: Uint8Array,
  a: Uint8Array,
  b: Uint8Array,
) {
  if (key.length !== 16 || a.length !== 16 || b.length !== 16)
    throw new Ev2Error('NFC_ADMIN_PARAMETRO_INVALIDO');
  const mix = Uint8Array.from(a.slice(2, 8).map((x, i) => x ^ b[i]!));
  const suffix = bytes(a.slice(0, 2), mix, b.slice(6, 16), a.slice(8, 16));
  try {
    return {
      enc: crypto.cmac(key, bytes(Uint8Array.of(0xa5, 0x5a, 0, 1, 0, 0x80), suffix)),
      mac: crypto.cmac(key, bytes(Uint8Array.of(0x5a, 0xa5, 0, 1, 0, 0x80), suffix)),
    };
  } finally {
    mix.fill(0);
    suffix.fill(0);
  }
}
function apdu(instruction: number, data: Uint8Array): Uint8Array {
  if (data.length > 255) throw new Ev2Error('NFC_ADMIN_QUADRO_EXCEDIDO');
  return data.length
    ? bytes(Uint8Array.of(0x90, instruction, 0, 0, data.length), data, Uint8Array.of(0))
    : Uint8Array.of(0x90, instruction, 0, 0, 0);
}
function response(input: Uint8Array, status: number): Uint8Array {
  if (input.length < 2 || input.length > 258) throw new Ev2Error('NFC_ADMIN_RESPOSTA_INVALIDA');
  const sw = input.at(-2)! * 256 + input.at(-1)!;
  if (sw !== status)
    throw new Ev2Error('NFC_ADMIN_STATUS_RECUSADO', sw.toString(16).toUpperCase().padStart(4, '0'));
  return input.slice(0, -2);
}

export interface Ev2Command {
  instruction: number;
  header: Uint8Array;
  data?: Uint8Array;
  mode: 'MAC' | 'FULL';
  responseLength: number | 'FILE_SETTINGS';
  dropsAuthentication?: boolean;
  expectedUid?: Uint8Array;
}
export interface Ev2Keys {
  enc: Uint8Array;
  mac: Uint8Array;
}
export function commandIv(
  crypto: Ev2Cryptography,
  key: Uint8Array,
  ti: Uint8Array,
  counter: number,
  reply = false,
) {
  if (ti.length !== 4 || key.length !== 16) throw new Ev2Error('NFC_ADMIN_PARAMETRO_INVALIDO');
  return crypto.encrypt(
    key,
    zero(),
    bytes(
      Uint8Array.of(...(reply ? [0x5a, 0xa5] : [0xa5, 0x5a])),
      ti,
      littleEndian(counter, 2),
      new Uint8Array(8),
    ),
  );
}
// Stateless codec also supports independent published known-answer tests.
export function protectCommand(
  crypto: Ev2Cryptography,
  keys: Ev2Keys,
  ti: Uint8Array,
  counter: number,
  command: Ev2Command,
) {
  integer(counter, 0xfffe);
  const iv =
    command.mode === 'FULL' && command.data ? commandIv(crypto, keys.enc, ti, counter) : null;
  const plain = command.data && command.mode === 'FULL' ? padMethod2(command.data) : null;
  let payload: Uint8Array | undefined;
  try {
    payload = plain ? crypto.encrypt(keys.enc, iv!, plain) : (command.data ?? new Uint8Array());
    const mac = mac8(
      crypto.cmac(
        keys.mac,
        bytes(
          Uint8Array.of(command.instruction),
          littleEndian(counter, 2),
          ti,
          command.header,
          payload,
        ),
      ),
    );
    return apdu(command.instruction, bytes(command.header, payload, mac));
  } finally {
    iv?.fill(0);
    plain?.fill(0);
  }
}

type Phase = 'NEW' | 'AUTH_PART1' | 'AUTH_PART2' | 'AUTHENTICATED' | 'COMMAND' | 'CLOSED';
export interface Ev2Receipt {
  data: Uint8Array;
  responseAuthenticated: boolean;
  reauthenticationRequired: boolean;
}

/** One RF session. No persistence, logging, automatic resend or fallback credentials. */
export class Ev2Channel {
  #phase: Phase = 'NEW';
  #key: Uint8Array | undefined;
  #a: Uint8Array | undefined;
  #b: Uint8Array | undefined;
  #keys: Ev2Keys | undefined;
  #ti: Uint8Array | undefined;
  #keyNumber: number | undefined;
  #counter = 0;
  #nonFirst = false;
  #pending: Ev2Command | undefined;
  #uidVerified = false;
  constructor(
    private readonly crypto: Ev2Cryptography,
    private readonly maximumCommands = 128,
  ) {
    integer(maximumCommands - 1, 0xfffe);
  }
  toJSON() {
    return {
      phase: this.#phase,
      authenticatedKeyNumber: this.#keyNumber,
      commandCounter: this.#counter,
    };
  }
  interrupt(): { requiresPhysicalRecovery: boolean } {
    const requiresPhysicalRecovery =
      this.#phase === 'COMMAND' && [0x8d, 0x5f, 0xc4].includes(this.#pending!.instruction);
    this.close();
    return { requiresPhysicalRecovery };
  }
  close(): void {
    this.#key?.fill(0);
    this.#a?.fill(0);
    this.#b?.fill(0);
    this.#keys?.enc.fill(0);
    this.#keys?.mac.fill(0);
    this.#ti?.fill(0);
    this.#key = this.#a = this.#b = this.#ti = undefined;
    this.#keys = this.#pending = undefined;
    this.#keyNumber = undefined;
    this.#phase = 'CLOSED';
    this.#uidVerified = false;
  }
  private requirePhase(phase: Phase): void {
    if (this.#phase !== phase) throw new Ev2Error('NFC_ADMIN_SEQUENCIA_INVALIDA');
  }
  private guarded<T>(action: () => T): T {
    try {
      return action();
    } catch (error) {
      const unknown =
        this.#phase === 'COMMAND' && [0x8d, 0x5f, 0xc4].includes(this.#pending!.instruction);
      this.close();
      if (error instanceof Ev2Error)
        throw new Ev2Error(
          error.code,
          error.statusWord,
          unknown ? 'NAO_CONFIRMADO' : error.physicalOutcome,
        );
      throw new Ev2Error(
        'NFC_ADMIN_CRIPTOGRAFIA_INVALIDA',
        undefined,
        unknown ? 'NAO_CONFIRMADO' : 'NAO_APLICAVEL',
      );
    }
  }
  authenticate(keyNumber: number, key: Uint8Array, nonFirst = false): Uint8Array {
    this.requirePhase(nonFirst ? 'AUTHENTICATED' : 'NEW');
    integer(keyNumber, 4);
    if (key.length !== 16) throw new Ev2Error('NFC_ADMIN_PARAMETRO_INVALIDO');
    this.#key = Uint8Array.from(key);
    this.#keyNumber = keyNumber;
    this.#nonFirst = nonFirst;
    this.#phase = 'AUTH_PART1';
    return apdu(nonFirst ? 0x77 : 0x71, Uint8Array.from(nonFirst ? [keyNumber] : [keyNumber, 0]));
  }
  challenge(raw: Uint8Array): Uint8Array {
    this.requirePhase('AUTH_PART1');
    return this.guarded(() => {
      const cipher = response(raw, 0x91af);
      if (cipher.length !== 16) throw new Ev2Error('NFC_ADMIN_RESPOSTA_INVALIDA');
      this.#b = this.crypto.decrypt(this.#key!, zero(), cipher);
      this.#a = this.crypto.random16();
      if (this.#a.length !== 16 || this.#b.length !== 16)
        throw new Ev2Error('NFC_ADMIN_CRIPTOGRAFIA_INVALIDA');
      const plain = bytes(this.#a, rotate(this.#b));
      try {
        const next = apdu(0xaf, this.crypto.encrypt(this.#key!, zero(), plain));
        this.#phase = 'AUTH_PART2';
        return next;
      } finally {
        plain.fill(0);
      }
    });
  }
  authenticated(raw: Uint8Array): void {
    this.requirePhase('AUTH_PART2');
    this.guarded(() => {
      const cipher = response(raw, 0x9100);
      if (cipher.length !== (this.#nonFirst ? 16 : 32))
        throw new Ev2Error('NFC_ADMIN_RESPOSTA_INVALIDA');
      const plain = this.crypto.decrypt(this.#key!, zero(), cipher);
      try {
        const start = this.#nonFirst ? 0 : 4;
        if (!this.crypto.equal(plain.slice(start, start + 16), rotate(this.#a!)))
          throw new Ev2Error('NFC_ADMIN_AUTENTICACAO_INVALIDA');
        if (!this.#nonFirst) {
          if (plain[20]! & 2 || !this.crypto.equal(plain.slice(26), new Uint8Array(6)))
            throw new Ev2Error('NFC_ADMIN_CAPACIDADES_INCOMPATIVEIS');
          this.#ti = Uint8Array.from(plain.subarray(0, 4));
          this.#counter = 0;
        }
        const next = sessionKeys(this.crypto, this.#key!, this.#a!, this.#b!);
        this.#keys?.enc.fill(0);
        this.#keys?.mac.fill(0);
        this.#keys = next;
        this.#key!.fill(0);
        this.#a!.fill(0);
        this.#b!.fill(0);
        this.#key = this.#a = this.#b = undefined;
        this.#phase = 'AUTHENTICATED';
      } finally {
        plain.fill(0);
      }
    });
  }
  private prepare(command: Ev2Command): Uint8Array {
    this.requirePhase('AUTHENTICATED');
    return this.guarded(() => {
      if (this.#counter >= this.maximumCommands) throw new Ev2Error('NFC_ADMIN_CONTADOR_ESGOTADO');
      const next = protectCommand(this.crypto, this.#keys!, this.#ti!, this.#counter, command);
      // Retain only non-secret response expectations, never old/new key command data.
      this.#pending = {
        instruction: command.instruction,
        mode: command.mode,
        header: new Uint8Array(),
        responseLength: command.responseLength,
        dropsAuthentication: command.dropsAuthentication,
        expectedUid: command.expectedUid ? Uint8Array.from(command.expectedUid) : undefined,
      };
      this.#phase = 'COMMAND';
      return next;
    });
  }
  complete(raw: Uint8Array): Ev2Receipt {
    this.requirePhase('COMMAND');
    return this.guarded(() => {
      const result = response(raw, 0x9100);
      const pending = this.#pending!;
      // Changing AppMasterKey intentionally ends authentication (NXP AN12196 table 26).
      // 9100 alone is not authenticated evidence of installation: re-authenticate to confirm.
      if (pending.dropsAuthentication) {
        if (result.length !== 0) throw new Ev2Error('NFC_ADMIN_RESPOSTA_INVALIDA');
        this.close();
        return {
          data: new Uint8Array(),
          responseAuthenticated: false,
          reauthenticationRequired: true,
        };
      }
      if (result.length < 8) throw new Ev2Error('NFC_ADMIN_RESPOSTA_INVALIDA');
      const payload = result.slice(0, -8);
      const nextCounter = this.#counter + 1;
      const expected = mac8(
        this.crypto.cmac(
          this.#keys!.mac,
          bytes(Uint8Array.of(0), littleEndian(nextCounter, 2), this.#ti!, payload),
        ),
      );
      if (!this.crypto.equal(expected, result.slice(-8)))
        throw new Ev2Error('NFC_ADMIN_MAC_INVALIDO');
      if (pending.responseLength === 0 && payload.length)
        throw new Ev2Error('NFC_ADMIN_RESPOSTA_INVALIDA');
      let data: Uint8Array = payload;
      if (pending.mode === 'FULL' && payload.length) {
        if (payload.length % 16) throw new Ev2Error('NFC_ADMIN_RESPOSTA_INVALIDA');
        const iv = commandIv(this.crypto, this.#keys!.enc, this.#ti!, nextCounter, true);
        const plain = this.crypto.decrypt(this.#keys!.enc, iv, payload);
        try {
          data = unpadMethod2(plain);
        } finally {
          iv.fill(0);
          plain.fill(0);
        }
      }
      if (
        pending.responseLength === 'FILE_SETTINGS'
          ? data.length < 7 || data.length > 40
          : data.length !== pending.responseLength
      )
        throw new Ev2Error('NFC_ADMIN_RESPOSTA_INVALIDA');
      if (pending.expectedUid) {
        if (!this.crypto.equal(data, pending.expectedUid))
          throw new Ev2Error('NFC_ADMIN_UID_DIVERGENTE');
        this.#uidVerified = true;
      }
      this.#counter = nextCounter;
      this.#pending = undefined;
      this.#phase = 'AUTHENTICATED';
      return { data, responseAuthenticated: true, reauthenticationRequired: false };
    });
  }
  uid(): Uint8Array {
    return this.prepare({
      instruction: 0x51,
      header: new Uint8Array(),
      mode: 'FULL',
      responseLength: 7,
    });
  }
  confirmUid(expectedUid: Uint8Array): Uint8Array {
    if (expectedUid.length !== 7) throw new Ev2Error('NFC_ADMIN_PARAMETRO_INVALIDO');
    return this.prepare({
      instruction: 0x51,
      header: new Uint8Array(),
      mode: 'FULL',
      responseLength: 7,
      expectedUid,
    });
  }
  settings(fileNumber: 1 | 2 | 3 = 2): Uint8Array {
    integer(fileNumber - 1, 2);
    return this.prepare({
      instruction: 0xf5,
      header: Uint8Array.of(fileNumber),
      mode: 'MAC',
      responseLength: 'FILE_SETTINGS',
    });
  }
  keyVersion(keyNumber: number): Uint8Array {
    integer(keyNumber, 4);
    return this.prepare({
      instruction: 0x64,
      header: Uint8Array.of(keyNumber),
      mode: 'MAC',
      responseLength: 1,
    });
  }
  read(fileNumber: 1 | 2 | 3, offset: number, length: number, mode: 'MAC' | 'FULL'): Uint8Array {
    if (mode !== 'MAC' && mode !== 'FULL') throw new Ev2Error('NFC_ADMIN_PARAMETRO_INVALIDO');
    this.range(fileNumber, offset, length);
    return this.prepare({
      instruction: 0xad,
      header: bytes(Uint8Array.of(fileNumber), littleEndian(offset, 3), littleEndian(length, 3)),
      mode,
      responseLength: length,
    });
  }
  write(fileNumber: 1 | 2 | 3, offset: number, data: Uint8Array): Uint8Array {
    this.master();
    this.range(fileNumber, offset, data.length);
    return this.prepare({
      instruction: 0x8d,
      header: bytes(
        Uint8Array.of(fileNumber),
        littleEndian(offset, 3),
        littleEndian(data.length, 3),
      ),
      data,
      mode: 'FULL',
      responseLength: 0,
    });
  }
  changeSettings(fileNumber: 1 | 2 | 3, encoded: Uint8Array): Uint8Array {
    this.master();
    integer(fileNumber - 1, 2);
    if (encoded.length < 3 || encoded.length > 36)
      throw new Ev2Error('NFC_ADMIN_PARAMETRO_INVALIDO');
    if (
      encoded[0]! & ~0x43 ||
      ![0, 1, 3].includes(encoded[0]! & 3) ||
      ![0, 0xe0].includes(encoded[2]! & 0xf0)
    )
      throw new Ev2Error('NFC_ADMIN_PERMISSAO_INSEGURA');
    if (
      (encoded[1]! & 15) !== 0 ||
      (encoded[2]! & 15) !== 0 ||
      ![0, 0xf0].includes(encoded[1]! & 0xf0)
    )
      throw new Ev2Error('NFC_ADMIN_PERMISSAO_INSEGURA');
    return this.prepare({
      instruction: 0x5f,
      header: Uint8Array.of(fileNumber),
      data: encoded,
      mode: 'FULL',
      responseLength: 0,
    });
  }
  changeKey(
    keyNumber: number,
    previous: Uint8Array,
    next: Uint8Array,
    version: number,
  ): Uint8Array {
    this.master();
    integer(keyNumber, 4);
    integer(version, 255);
    if (previous.length !== 16 || next.length !== 16)
      throw new Ev2Error('NFC_ADMIN_PARAMETRO_INVALIDO');
    const body =
      keyNumber === 0
        ? bytes(next, Uint8Array.of(version))
        : bytes(
            Uint8Array.from(next.map((x, i) => x ^ previous[i]!)),
            Uint8Array.of(version),
            crc32NewKey(next),
          );
    try {
      return this.prepare({
        instruction: 0xc4,
        header: Uint8Array.of(keyNumber),
        data: body,
        mode: 'FULL',
        responseLength: 0,
        dropsAuthentication: keyNumber === 0,
      });
    } finally {
      body.fill(0);
    }
  }
  private master(): void {
    this.requirePhase('AUTHENTICATED');
    if (this.#keyNumber !== 0) throw new Ev2Error('NFC_ADMIN_CHAVE_ADMINISTRATIVA_OBRIGATORIA');
    if (!this.#uidVerified) throw new Ev2Error('NFC_ADMIN_UID_NAO_CONFIRMADO');
  }
  private range(file: 1 | 2 | 3, offset: number, length: number): void {
    integer(file - 1, 2);
    integer(offset, 255);
    integer(length - 1, 127);
    const capacity = [32, 256, 128][file - 1]!;
    if (offset + length > capacity) throw new Ev2Error('NFC_ADMIN_LIMITE_ARQUIVO');
  }
}
