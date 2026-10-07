import { config as loadEnv } from 'dotenv';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ImportNfcInventory } from '../../bounded-contexts/tag-administration/application/administration-service';
import { RewrapNfcInventory } from '../../bounded-contexts/tag-administration/application/rewrap-inventory';
import { NodeCredentialVault } from '../../bounded-contexts/tag-administration/infrastructure/credential-vault';
import { PostgresAdministrationStore } from '../../bounded-contexts/tag-administration/infrastructure/postgres-administration-store';
import { createDataSource } from '../database/data-source';
import { loadSdmEnv } from './sdm-env';
import { NodeIds, SystemClock } from '../runtime';

export function parseInventory(value: unknown): {
  uid: string;
  versions: number[];
  keys: Uint8Array;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid inventory');
  const obj = value as Record<string, unknown>;
  if (
    Object.keys(obj).sort().join(',') !== 'slots,uid' ||
    typeof obj.uid !== 'string' ||
    !/^[0-9A-F]{14}$/.test(obj.uid) ||
    !Array.isArray(obj.slots) ||
    obj.slots.length !== 5
  )
    throw new Error('Invalid inventory');
  const keys = new Uint8Array(80),
    versions: number[] = [];
  try {
    for (let slot = 0; slot < 5; slot++) {
      const item: unknown = obj.slots[slot];
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error();
      const s = item as Record<string, unknown>;
      if (
        Object.keys(s).sort().join(',') !== 'chaveHex,numero,versao' ||
        s.numero !== slot ||
        typeof s.versao !== 'number' ||
        !Number.isInteger(s.versao) ||
        s.versao < 0 ||
        s.versao > 255 ||
        typeof s.chaveHex !== 'string' ||
        !/^[0-9a-fA-F]{32}$/.test(s.chaveHex)
      )
        throw new Error();
      keys.set(Buffer.from(s.chaveHex, 'hex'), slot * 16);
      versions.push(s.versao);
    }
    return { uid: obj.uid, versions, keys };
  } catch {
    keys.fill(0);
    throw new Error('Invalid inventory');
  }
}
async function main(): Promise<void> {
  if (process.argv[2] === 'rewrap') {
    if (process.argv.length !== 3) throw new Error('Use rewrap without private material arguments');
    loadEnv({ quiet: true });
    loadSdmEnv();
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
    const vault = new NodeCredentialVault(
      process.env.SDM_ACTIVE_MASTER_VERSION,
      process.env.SDM_MASTER_KEYS_JSON,
    );
    try {
      const source = await createDataSource(process.env.DATABASE_URL).initialize();
      try {
        const result = await new RewrapNfcInventory(
          new PostgresAdministrationStore(source),
          vault,
          new SystemClock(),
          new NodeIds(),
        ).execute();
        process.stdout.write(
          JSON.stringify({ envelopesRotacionados: result, chavesFisicasAlteradas: false }) + '\n',
        );
      } finally {
        await source.destroy();
      }
    } finally {
      vault.close();
    }
    return;
  }
  const index = process.argv.indexOf('--input');
  if (process.argv[2] !== 'import' || index < 0 || !process.argv[index + 1])
    throw new Error('Use import --input .tmp/private/tag-credentials.json');
  const root = resolve('.tmp/private'),
    path = resolve(process.argv[index + 1]!);
  if (
    dirname(path) !== root ||
    realpathSync(root) !== root ||
    realpathSync(path) !== path ||
    !statSync(path).isFile() ||
    statSync(path).size > 8192
  )
    throw new Error('Inventory must be a regular private file directly inside .tmp/private');
  if (process.platform === 'win32') {
    // Replace the DACL, including explicit entries; /grant:r alone leaves other principals.
    const aclScript =
      '$ErrorActionPreference="Stop"; $identity=[System.Security.Principal.WindowsIdentity]::GetCurrent(); ' +
      '$acl=[System.Security.AccessControl.FileSecurity]::new(); $acl.SetOwner($identity.User); ' +
      '$acl.SetAccessRuleProtection($true,$false); ' +
      '$rule=[System.Security.AccessControl.FileSystemAccessRule]::new($identity.User,[System.Security.AccessControl.FileSystemRights]::FullControl,[System.Security.AccessControl.AccessControlType]::Allow); ' +
      '$acl.AddAccessRule($rule); [System.IO.File]::SetAccessControl($env:TASK_NFC_PRIVATE_INPUT,$acl);';
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-EncodedCommand',
        Buffer.from(aclScript, 'utf16le').toString('base64'),
      ],
      { stdio: 'ignore', windowsHide: true, env: { ...process.env, TASK_NFC_PRIVATE_INPUT: path } },
    );
  } else if ((statSync(path).mode & 0o077) !== 0)
    throw new Error('Inventory requires owner-only permissions');
  const inventory = parseInventory(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  let vault: NodeCredentialVault | undefined;
  try {
    loadEnv({ quiet: true });
    loadSdmEnv();
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
    vault = new NodeCredentialVault(
      process.env.SDM_ACTIVE_MASTER_VERSION,
      process.env.SDM_MASTER_KEYS_JSON,
    );
    const source = await createDataSource(process.env.DATABASE_URL).initialize();
    try {
      const result = await new ImportNfcInventory(
        new PostgresAdministrationStore(source),
        vault,
        new SystemClock(),
        new NodeIds(),
      ).execute(inventory.uid, inventory.versions, inventory.keys);
      process.stdout.write(
        JSON.stringify({
          referenciaCredenciais: result.reference,
          declarado: true,
          autenticadoFisicamente: false,
        }) + '\n',
      );
    } finally {
      await source.destroy();
    }
  } finally {
    inventory.keys.fill(0);
    vault?.close();
  }
}
if (require.main === module)
  void main().catch(() => {
    process.stderr.write(
      'Operação do cofre NFC não concluída. Confira arquivo privado, cinco slots, versões mestras e operação pendente. Nenhuma chave será exibida.\n',
    );
    process.exitCode = 1;
  });
