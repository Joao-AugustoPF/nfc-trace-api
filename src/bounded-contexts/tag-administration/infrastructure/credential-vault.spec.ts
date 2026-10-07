import { randomBytes, randomUUID } from 'node:crypto';
import { NodeCredentialVault } from './credential-vault';
import { parseInventory } from '../../../platform/access/nfc-inventory-cli';

describe('NFC credential vault (synthetic secrets)', () => {
  const uid = '04112233445566';
  const versions = [1, 2, 3, 4, 5];
  const ring = JSON.stringify({ '1': randomBytes(32).toString('base64') });
  it('authenticates identity/UID/versions/purpose and seals all five slots without modifying input', () => {
    const vault = new NodeCredentialVault('1', ring),
      keys = randomBytes(80),
      original = Buffer.from(keys);
    const record = {
      id: randomUUID(),
      uid,
      versions,
      sealed: vault.seal(randomUUID(), uid, versions, keys),
      createdAt: new Date().toISOString(),
    };
    record.sealed = vault.seal(record.id, uid, versions, keys);
    const plain = vault.unseal(record);
    expect(Buffer.from(plain)).toEqual(keys);
    plain.fill(0);
    expect(keys).toEqual(original);
    for (const modified of [
      { ...record, id: randomUUID() },
      { ...record, uid: '04112233445567' },
      { ...record, versions: [1, 2, 3, 4, 6] },
      {
        ...record,
        sealed: { ...record.sealed, authenticationTag: randomBytes(16).toString('base64') },
      },
    ])
      expect(() => vault.unseal(modified)).toThrow('Recupere a configuração');
    expect(JSON.stringify(vault)).not.toContain(JSON.parse(ring)['1']);
    vault.close();
    expect(() => vault.unseal(record)).toThrow();
  });
  it('retains older wrapping versions and fails closed without a configured master', () => {
    const old = new NodeCredentialVault('1', ring),
      keys = randomBytes(80),
      id = randomUUID();
    const record = {
      id,
      uid,
      versions,
      sealed: old.seal(id, uid, versions, keys),
      createdAt: new Date().toISOString(),
    };
    const newer = new NodeCredentialVault(
      '2',
      JSON.stringify({ ...JSON.parse(ring), '2': randomBytes(32).toString('base64') }),
    );
    expect(Buffer.from(newer.unseal(record))).toEqual(keys);
    expect(() => new NodeCredentialVault().unseal(record)).toThrow();
    old.close();
    newer.close();
  });
  it('requires an explicit, complete inventory, with no factory/default fallback', () => {
    const slots = versions.map((versao, numero) => ({
      numero,
      versao,
      chaveHex: randomBytes(16).toString('hex'),
    }));
    const parsed = parseInventory({ uid, slots });
    expect(parsed.keys.length).toBe(80);
    expect(parsed.versions).toEqual(versions);
    parsed.keys.fill(0);
    for (const invalid of [
      { uid, slots: slots.slice(1) },
      { uid, slots: [slots[0], slots[0], ...slots.slice(2)] },
      { uid, slots: slots.map((s) => ({ ...s, chaveHex: undefined })) },
      { uid, slots: slots.map((s) => ({ ...s, versao: 256 })) },
      { uid, slots, senha: 'discard' },
      { uid: '53:72:1F:76:95:00:01', slots },
    ])
      expect(() => parseInventory(invalid)).toThrow('Invalid inventory');
  });
});
