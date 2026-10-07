import { inspect } from 'node:util';
import { NodeEv2Cryptography } from './ev2-crypto';
import {
  Ev2Channel,
  Ev2Error,
  crc32NewKey,
  sessionKeys,
  protectCommand,
  commandIv,
  padMethod2,
} from './ev2';

const h = (hex: string) => Buffer.from(hex, 'hex');
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex').toUpperCase();
// Public NXP AN12196 Rev 2.0 tables 14, 18, 23, 25, 26. Never lab key material.
const a = h('13C5DB8A5930439FC3DEF9A4C675360F');
const b = h('B9E2FC789B64BF237CCCAA20EC7E6E48');
const ti = h('9D00C4DF');
const key = Buffer.alloc(16);
const keys = {
  enc: h('1309C877509E5A215007FF0ED19CA564'),
  mac: h('4C6626F5E72EA694202139295C7A7FC7'),
};
const challenge = h('A04C124213C186F22399D33AC2A3021591AF');
const authentication = h('3FA64DB5446D1F34CD6EA311167F5E4985B89690C04A05F17FA7AB2F081206639100');
const settings = h('4000E0C1F121200000430000430000');
const uid = h('04968CAA5C5E80');

class FixedNonce extends NodeEv2Cryptography {
  override random16() {
    return Uint8Array.from(a);
  }
}
function authenticated(crypto = new FixedNonce(), budget = 128) {
  const session = new Ev2Channel(crypto, budget);
  expect(hex(session.authenticate(0, key))).toBe('9071000002000000');
  expect(hex(session.challenge(challenge))).toBe(
    '90AF00002035C3E05A752E0144BAC0DE51C1F22C56B34408A23D8AEA266CAB947EA8E0118D00',
  );
  session.authenticated(authentication);
  return session;
}

// Synthetic PICC reply for fault/state tests, not a known-answer vector or physical read.
// Uses fixed published session keys; no derivation or response codec from Ev2Channel.
function syntheticReply(data: Buffer, counter: number, full = true, padded = true) {
  const crypto = new NodeEv2Cryptography();
  const ctr = Buffer.alloc(2);
  ctr.writeUInt16LE(counter);
  const iv = crypto.encrypt(
    keys.enc,
    Buffer.alloc(16),
    Buffer.concat([h('5AA5'), ti, ctr, Buffer.alloc(8)]),
  );
  let payload: Uint8Array = data;
  if (full && data.length) {
    const plain = padded
      ? Buffer.concat([data, h('80'), Buffer.alloc(15 - (data.length % 16))])
      : data;
    payload = crypto.encrypt(keys.enc, iv, plain);
  }
  const complete = crypto.cmac(keys.mac, Buffer.concat([h('00'), ctr, ti, Buffer.from(payload)]));
  const mac = Buffer.from([1, 3, 5, 7, 9, 11, 13, 15].map((index) => complete[index]!));
  return Buffer.concat([Buffer.from(payload), mac, h('9100')]);
}
function confirm(session: Ev2Channel) {
  session.confirmUid(uid);
  expect(session.complete(syntheticReply(uid, 1))).toEqual({
    data: Uint8Array.from(uid),
    responseAuthenticated: true,
    reauthenticationRequired: false,
  });
}

describe('NTAG 424 EV2 administrative secure messaging (published/synthetic, no hardware)', () => {
  it('matches NXP authentication, session keys and FULL ChangeFileSettings byte for byte', () => {
    const crypto = new FixedNonce();
    const derived = sessionKeys(crypto, key, a, b);
    expect(hex(derived.enc)).toBe(hex(keys.enc));
    expect(hex(derived.mac)).toBe(hex(keys.mac));
    expect(hex(commandIv(crypto, keys.enc, ti, 1))).toBe('3E27082AB2ACC1EF55C57547934E9962');
    const session = authenticated(crypto);
    confirm(session);
    expect(hex(session.changeSettings(2, settings))).toBe(
      '905F0000190261B6D97903566E84C3AE5274467E89EAD799B7C1A0EF7A0400',
    );
    // NXP table 18 prints status before the MAC; native wrapped APDU puts SW1/SW2 last.
    expect(session.complete(h('57BFF87B1241E93D9100'))).toEqual({
      data: new Uint8Array(),
      responseAuthenticated: true,
      reauthenticationRequired: false,
    });
    expect(session.toJSON().commandCounter).toBe(2);
    expect(session.toJSON().phase).toBe('AUTHENTICATED');
    session.close();
  });
  it('matches both NXP ChangeKey cases, CRC and counter-dependent encryption/MAC', () => {
    const crypto = new NodeEv2Cryptography();
    const example = {
      enc: h('4CF3CB41A22583A61E89B158D252FC53'),
      mac: h('5529860B2FC5FB6154B7F28361D30BF9'),
    };
    const transaction = h('7614281A');
    const next = h('F3847D627727ED3BC9C4CC050489B966');
    expect(hex(crc32NewKey(next))).toBe('789DFADC');
    expect(
      hex(
        protectCommand(crypto, example, transaction, 2, {
          instruction: 0xc4,
          header: h('02'),
          data: Buffer.concat([next, h('01'), h('789DFADC')]),
          mode: 'FULL',
          responseLength: 0,
        }),
      ),
    ).toBe(
      '90C4000029022CF362B7BF4311FF3BE1DAA295E8C68DE09050560D19B9E16C2393AE9CD1FAC75D0CE20BCD1D06E600',
    );
    expect(
      hex(
        protectCommand(crypto, example, transaction, 3, {
          instruction: 0xc4,
          header: h('00'),
          data: h('5004BF991F408672B1EF00F08F9E864701'),
          mode: 'FULL',
          responseLength: 0,
          dropsAuthentication: true,
        }),
      ),
    ).toBe(
      '90C400002900C0EB4DEEFEDDF0B513A03A95A75491818580503190D4D05053FF75668A01D6FDA6610234BDED643200',
    );
    expect(padMethod2(Buffer.alloc(16))).toHaveLength(32);
  });
  it('preserves TI/counter in AuthenticateEV2NonFirst and replaces the session keys', () => {
    const crypto = new FixedNonce();
    const session = authenticated(crypto);
    confirm(session);
    session.changeSettings(2, settings);
    session.complete(h('57BFF87B1241E93D9100'));
    crypto.random16 = () => Uint8Array.from(h('60BE759EDA560250AC57CDDC11743CF6'));
    expect(hex(session.authenticate(0, key, true))).toBe('90770000010000');
    expect(hex(session.challenge(h('A6A2B3C572D06C097BB8DB70463E22DC91AF')))).toBe(
      '90AF000020BE7D45753F2CAB85F34BC60CE58B940763FE969658A532DF6D95EA2773F6E99100',
    );
    session.authenticated(h('B888349C24B315EAB5B589E279C8263E9100'));
    expect(session.toJSON().commandCounter).toBe(2);
    expect(hex(session.keyVersion(2))).toBe(
      hex(
        protectCommand(
          crypto,
          {
            enc: h('4CF3CB41A22583A61E89B158D252FC53'),
            mac: h('5529860B2FC5FB6154B7F28361D30BF9'),
          },
          ti,
          2,
          { instruction: 0x64, header: h('02'), mode: 'MAC', responseLength: 1 },
        ),
      ),
    );
    session.close();
  });
  it.each(['91AE', '91AD', '919D', '9000', '91AF'])(
    'terminates on status %s without retry or fallback',
    (sw) => {
      const session = authenticated();
      session.settings();
      expect(() => session.complete(h(sw))).toThrow(Ev2Error);
      expect(session.toJSON().phase).toBe('CLOSED');
      expect(() => session.authenticate(0, key)).toThrow(Ev2Error);
    },
  );
  it('rejects changed nonce/capability echo and never creates an authenticated session', () => {
    for (const offset of [4, 20, 26]) {
      const crypto = new FixedNonce();
      const session = new Ev2Channel(crypto);
      session.authenticate(0, key);
      session.challenge(challenge);
      const plain = Buffer.from(
        crypto.decrypt(key, Buffer.alloc(16), authentication.subarray(0, 32)),
      );
      plain[offset] = plain[offset]! ^ 2;
      const altered = Buffer.concat([
        Buffer.from(crypto.encrypt(key, Buffer.alloc(16), plain)),
        h('9100'),
      ]);
      expect(() => session.authenticated(altered)).toThrow(Ev2Error);
      expect(session.toJSON().phase).toBe('CLOSED');
    }
  });
  it('rejects truncation/extra authentication frames, including LRP, before continuing', () => {
    for (const input of [
      h('91AF'),
      h('00'.repeat(15) + '91AF'),
      h('01' + '00'.repeat(16) + '91AF'),
    ]) {
      const session = new Ev2Channel(new FixedNonce());
      session.authenticate(0, key);
      expect(() => session.challenge(input)).toThrow(Ev2Error);
      expect(session.toJSON().phase).toBe('CLOSED');
    }
  });
  it('requires an authenticated expected UID before any mutation, even with the factory key', () => {
    const session = authenticated();
    expect(() => session.write(2, 0, h('00'))).toThrow(
      expect.objectContaining({ code: 'NFC_ADMIN_UID_NAO_CONFIRMADO' }),
    );
    session.uid();
    session.complete(syntheticReply(uid, 1));
    expect(() => session.changeKey(1, key, key, 1)).toThrow(
      expect.objectContaining({ code: 'NFC_ADMIN_UID_NAO_CONFIRMADO' }),
    );
    session.confirmUid(h('04AABBCCDDEE01'));
    expect(() => session.complete(syntheticReply(uid, 2))).toThrow(
      expect.objectContaining({ code: 'NFC_ADMIN_UID_DIVERGENTE' }),
    );
    expect(session.toJSON().phase).toBe('CLOSED');
  });
  it('requires slot 0 for writes, retains caller-owned keys and serializes no private material', () => {
    const original = Buffer.from('8123456789ABCDEF0123456789ABCDEF', 'hex');
    const untouched = Buffer.from(original);
    const channel = new Ev2Channel(new FixedNonce());
    channel.authenticate(0, original);
    channel.close();
    expect(original).toEqual(untouched);
    expect(JSON.stringify(channel) + inspect(channel, { showHidden: true })).not.toContain(
      original.toString('hex'),
    );
    const session = new Ev2Channel(new FixedNonce());
    session.authenticate(1, key);
    session.challenge(challenge);
    session.authenticated(authentication);
    confirm(session);
    expect(() => session.write(2, 0, h('00'))).toThrow(
      expect.objectContaining({ code: 'NFC_ADMIN_CHAVE_ADMINISTRATIVA_OBRIGATORIA' }),
    );
    session.close();
  });
  it('checks MAC before releasing plaintext and closes on replay, missing MAC or bad padding', () => {
    for (const fault of ['MAC', 'PADDING', 'SHORT', 'COUNTER']) {
      const session = authenticated();
      session.uid();
      let reply = syntheticReply(uid, fault === 'COUNTER' ? 2 : 1);
      if (fault === 'MAC') reply[reply.length - 3] = reply[reply.length - 3]! ^ 1;
      if (fault === 'SHORT') reply = h('9100');
      if (fault === 'PADDING') reply = syntheticReply(Buffer.alloc(16), 1, true, false);
      expect(() => session.complete(reply)).toThrow(Ev2Error);
      expect(session.toJSON().phase).toBe('CLOSED');
    }
  });
  it('accepts MAC-protected settings and exact FULL read lengths, retaining plaintext after wipe', () => {
    const session = authenticated();
    session.settings(2);
    const settingsBytes = h('0043F0E0000100C1FF124B0000070000710000');
    expect(hex(session.complete(syntheticReply(settingsBytes, 1, false)).data)).toBe(
      hex(settingsBytes),
    );
    const data = Buffer.from('1234567890abcdef');
    session.read(2, 0, 16, 'FULL');
    expect(hex(session.complete(syntheticReply(data, 2)).data)).toBe(hex(data));
    session.close();
  });
  it('refuses a concurrent command and exhausts its budget without wrapping', () => {
    const session = authenticated(new FixedNonce(), 1);
    session.uid();
    expect(() => session.settings()).toThrow(Ev2Error);
    session.complete(syntheticReply(uid, 1));
    expect(() => session.uid()).toThrow(
      expect.objectContaining({ code: 'NFC_ADMIN_CONTADOR_ESGOTADO' }),
    );
    expect(() =>
      protectCommand(new FixedNonce(), keys, ti, 65535, {
        instruction: 0x51,
        header: h(''),
        mode: 'FULL',
        responseLength: 7,
      }),
    ).toThrow(Ev2Error);
    expect(session.toJSON().phase).toBe('CLOSED');
  });
  it('enforces short frames/file boundaries and rejects irreversible/lax access settings', () => {
    const session = authenticated();
    confirm(session);
    for (const setting of ['43FFE0', '43F0EE', '43E0E0', '43F0F0', 'C3F0E0'])
      expect(() => session.changeSettings(2, h(setting))).toThrow(Ev2Error);
    expect(() => session.write(1, 31, h('0000'))).toThrow(Ev2Error);
    expect(() => session.write(2, 129, Buffer.alloc(128))).toThrow(Ev2Error);
    expect(() => session.write(2, 0, Buffer.alloc(129))).toThrow(Ev2Error);
    expect(() => session.changeKey(5, key, key, 1)).toThrow(Ev2Error);
    session.close();
  });
  it('does not interpret an unauthenticated slot-0 change ACK as installation proof', () => {
    const session = authenticated();
    confirm(session);
    const next = h('5004BF991F408672B1EF00F08F9E8647');
    session.changeKey(0, key, next, 1);
    expect(session.complete(h('9100'))).toEqual({
      data: new Uint8Array(),
      responseAuthenticated: false,
      reauthenticationRequired: true,
    });
    expect(session.toJSON().phase).toBe('CLOSED');
    expect(() => session.write(2, 0, h('00'))).toThrow(Ev2Error);
  });
  it('wipes owned authentication/session key buffers on transport cancellation', () => {
    const borrowed: Uint8Array[] = [];
    class RecordingCrypto extends FixedNonce {
      override encrypt(k: Uint8Array, iv: Uint8Array, data: Uint8Array) {
        borrowed.push(k);
        return super.encrypt(k, iv, data);
      }
      override decrypt(k: Uint8Array, iv: Uint8Array, data: Uint8Array) {
        borrowed.push(k);
        return super.decrypt(k, iv, data);
      }
      override cmac(k: Uint8Array, data: Uint8Array) {
        borrowed.push(k);
        return super.cmac(k, data);
      }
    }
    const session = authenticated(new RecordingCrypto());
    confirm(session);
    session.write(2, 0, h('00'));
    expect(session.interrupt()).toEqual({ requiresPhysicalRecovery: true });
    expect(borrowed.length).toBeGreaterThan(5);
    expect(borrowed.every((k) => k.every((byte) => byte === 0))).toBe(true);
    expect(() => session.complete(h('9100'))).toThrow(Ev2Error);
  });
  it('reports uncertain physical outcomes after a missing/corrupted mutation ACK', () => {
    const session = authenticated();
    confirm(session);
    session.write(2, 0, h('00'));
    expect(() => session.complete(h('9100'))).toThrow(
      expect.objectContaining({
        code: 'NFC_ADMIN_RESPOSTA_INVALIDA',
        physicalOutcome: 'NAO_CONFIRMADO',
      }),
    );
    expect(session.toJSON().phase).toBe('CLOSED');
    const readSession = authenticated();
    readSession.uid();
    expect(readSession.interrupt()).toEqual({ requiresPhysicalRecovery: false });
  });
  it('rejects an old response during the next command instead of advancing the counter twice', () => {
    const session = authenticated();
    const prior = syntheticReply(uid, 1);
    session.uid();
    session.complete(prior);
    session.uid();
    expect(() => session.complete(prior)).toThrow(
      expect.objectContaining({ code: 'NFC_ADMIN_MAC_INVALIDO' }),
    );
    expect(session.toJSON().phase).toBe('CLOSED');
  });
});
