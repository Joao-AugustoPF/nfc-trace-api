import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  aesCmac,
  decryptPicc,
  deriveSdmKey,
  NodeSdmCryptography,
  truncateSdmMac,
  sdmMessage,
} from './sdm-crypto';
import { SDM_PROFILE, SdmConfiguration, sdmUri } from '../domain/sdm';

const hex = (value: string) => Buffer.from(value, 'hex');
describe('Official cryptographic vectors (not NFC Trace profile or physical acceptance)', () => {
  it('matches the independently published Nova-tag candidate layout byte for byte', () => {
    const example = JSON.parse(readFileSync('docs/sdm-profile-v1.example.json', 'utf8')) as {
      plan: {
        profile: string;
        provisioningId: string;
        messageBytes: number[];
        offsets: { piccData: number; macInput: number; mac: number };
      };
    };
    expect(example.plan.profile).toBe(SDM_PROFILE);
    expect(sdmMessage(sdmUri(example.plan.provisioningId))).toEqual(
      Buffer.from(example.plan.messageBytes),
    );
    expect(example.plan.offsets).toMatchObject({ piccData: 75, macInput: 7, mac: 113 });
  });
  // NXP AN12196 Rev. 2.0, tables 1, 2, 4, 5. Expected values are independent of this implementation.
  it('derives session encryption and MAC keys from NXP table 1', () => {
    const key = hex('5ACE7E50AB65D5D51FD5BF5A16B8205B');
    const uid = hex('04C767F2066180');
    const counter = hex('010000');
    expect(deriveSdmKey(key, uid, counter, 'C33C00010080').toString('hex')).toBe(
      '66da61797e23deca5d8eca13bbadf7a9',
    );
    expect(deriveSdmKey(key, uid, counter).toString('hex')).toBe(
      '3a3e8110e05311f7a3fcf0d969bf2b48',
    );
  });
  it('decrypts encrypted PICC, little-endian counter, and empty-input MAC (tables 2 and 4)', () => {
    const picc = decryptPicc(Buffer.alloc(16), hex('EF963FF7828658A599F3041510671E88'));
    expect(picc.toString('hex')).toBe('c704de5f1eacc0403d0000da5cf60941');
    expect(picc.readUIntLE(8, 3)).toBe(61);
    const session = deriveSdmKey(Buffer.alloc(16), picc.subarray(1, 8), picc.subarray(8, 11));
    expect(session.toString('hex')).toBe('3fb5f6e3a807a03d5e3570ace393776f');
    const mac = aesCmac(session, Buffer.alloc(0));
    expect(mac.toString('hex')).toBe('e194c7ee12d9f7ee8a65c8331b704386');
    expect(truncateSdmMac(mac).toString('hex')).toBe('94eed9ee65337086');
  });
  it('matches the nonempty ASCII MAC input in NXP table 5', () => {
    const picc = decryptPicc(Buffer.alloc(16), hex('FD91EC264309878BE6345CBE53BADF40'));
    expect(picc.toString('hex')).toBe('c704958caa5c5e80080000a243c86dfc');
    const session = deriveSdmKey(Buffer.alloc(16), picc.subarray(1, 8), picc.subarray(8, 11));
    expect(session.toString('hex')).toBe('3ed0920e5e6a0320d823d5987feafbb1');
    const mac = aesCmac(session, Buffer.from('CEE9A53E3E463EF1F459635736738962&cmac=', 'ascii'));
    expect(mac.toString('hex')).toBe('81ec45c175e72ff6fac61bc7ab3baef6');
    expect(truncateSdmMac(mac).toString('hex')).toBe('ecc1e7f6c6c73bf6');
  });
  it('matches NIST AES-CMAC examples, including complete and incomplete blocks', () => {
    // https://csrc.nist.gov/CSRC/media/Projects/Cryptographic-Standards-and-Guidelines/documents/examples/AES_CMAC.pdf
    const key = hex('2b7e151628aed2a6abf7158809cf4f3c');
    const message = hex(
      [
        '6bc1bee22e409f96e93d7e117393172a',
        'ae2d8a571e03ac9c9eb76fac45af8e51',
        '30c81c46a35ce411e5fbc1191a0a52ef',
        'f69f2445df4f9b17ad2b417be66c3710',
      ].join(''),
    );
    for (const [length, expected] of [
      [0, 'bb1d6929e95937287fa37d129b756746'],
      [16, '070a16b46b4d4144f79bdd9dd04a287c'],
      [20, '7d85449ea6ea19c823a7bf78837dfade'],
      [64, '51f0bebf7e3b9d92fc49741779363cfe'],
    ] as const)
      expect(aesCmac(key, message.subarray(0, length)).toString('hex')).toBe(expected);
  });
});
describe('SDM encrypted vault', () => {
  const config: SdmConfiguration = {
    profile: SDM_PROFILE,
    policy: 'ESTRITA',
    keyReference: randomUUID(),
    keyVersion: 1,
  };
  it('generates distinct epoch keys, authenticates vault scope, and rewraps without changing tag keys', () => {
    const id = randomUUID();
    const masters = {
      '1': randomBytes(32).toString('base64'),
      '2': randomBytes(32).toString('base64'),
    };
    const old = new NodeSdmCryptography('1', JSON.stringify(masters));
    const next = new NodeSdmCryptography('2', JSON.stringify(masters));
    const sealed = old.generate(id, config);
    const plain = old.unseal(id, config, sealed);
    expect(plain.equals(old.unseal(id, config, old.generate(id, config)))).toBe(false);
    expect(() => old.unseal(randomUUID(), config, sealed)).toThrow('recuperar');
    expect(() => old.unseal(id, { ...config, keyReference: randomUUID() }, sealed)).toThrow(
      'recuperar',
    );
    const rewrapped = next.rewrap(id, config, sealed);
    expect(rewrapped.masterVersion).toBe('2');
    const recovered = new NodeSdmCryptography('2', JSON.stringify({ '2': masters['2'] }));
    expect(recovered.unseal(id, config, rewrapped).equals(plain)).toBe(true);
    expect(() => recovered.unseal(id, config, sealed)).toThrow('indisponível');
  });
  it('rejects incomplete or malformed master configuration without reflecting secrets', () => {
    expect(() => new NodeSdmCryptography('1', 'sensitive-invalid')).toThrow(
      'Invalid SDM vault configuration',
    );
    expect(() => new NodeSdmCryptography().generate(randomUUID(), config)).toThrow('indisponível');
  });
});
