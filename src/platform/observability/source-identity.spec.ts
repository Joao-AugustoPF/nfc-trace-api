import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { createRequire } from 'node:module';
import { publicBuildInfo } from './build-info';

const loadScript = createRequire(__filename);
const { identity } = loadScript('../../../scripts/source-identity.cjs') as {
  identity(root: string, kind: string): { sourceSha256: string; files: Record<string, string> };
};
const { identifier, restore } = loadScript('../../../scripts/lab-backup.cjs') as {
  identifier(value: string): string;
  restore(container: string, database: string, input: string): unknown;
};

describe('Delivery identity and backup boundaries', () => {
  it('changes source identity for code/lock changes and excludes private environment/files', () => {
    const folder = mkdtempSync(join(tmpdir(), 'nfc-source-identity-'));
    try {
      mkdirSync(join(folder, 'src'));
      writeFileSync(join(folder, 'package.json'), '{"version":"test"}');
      writeFileSync(join(folder, 'package-lock.json'), '{}');
      writeFileSync(join(folder, 'src/main.ts'), 'export const value = 1;');
      const before = identity(folder, 'api');
      writeFileSync(join(folder, '.env'), 'PRIVATE_SENTINEL=not-for-manifest');
      writeFileSync(join(folder, 'private.env'), 'PRIVATE_SENTINEL=also-not-for-manifest');
      expect(identity(folder, 'api')).toEqual(before);
      expect(Object.keys(before.files)).not.toContain('.env');
      writeFileSync(join(folder, 'src/main.ts'), 'export const value = 2;');
      expect(identity(folder, 'api').sourceSha256).not.toBe(before.sourceSha256);
      const after = identity(folder, 'api').sourceSha256;
      writeFileSync(join(folder, 'package-lock.json'), '{"lockfileVersion":3}');
      expect(identity(folder, 'api').sourceSha256).not.toBe(after);
    } finally {
      // Verify the exact mkdtemp path stays inside the OS temp directory before deletion.
      expect(relative(resolve(tmpdir()), resolve(folder))).not.toMatch(/^\.\./);
      rmSync(folder, { recursive: true });
    }
  });
  it('exposes only version/hash fields and explicitly marks source-mode execution', () => {
    const info = publicBuildInfo();
    expect(info.status).toBe('DESENVOLVIMENTO_SEM_MANIFESTO');
    expect(info.revision).toBeNull();
    expect(info).not.toHaveProperty('files');
    expect(info).not.toHaveProperty('databaseUrl');
    expect(info).not.toHaveProperty('sdmMasterKeysJson');
  });
  it('rejects SQL identifiers and non-test restoration before invoking Docker', () => {
    for (const value of ['public;DROP DATABASE nfc_trace', '../nfc_trace', 'a"b'])
      expect(() => identifier(value)).toThrow('Invalid');
    expect(() => restore('unused', 'nfc_trace', 'unused')).toThrow('NEW database ending in _test');
    expect(identifier('nfc_restore_test')).toBe('nfc_restore_test');
  });
});
