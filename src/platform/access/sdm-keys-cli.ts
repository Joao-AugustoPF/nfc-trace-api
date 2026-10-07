import { config as loadEnv } from 'dotenv';
import { randomBytes, randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { NodeSdmCryptography } from '../../bounded-contexts/traceability/infrastructure/sdm-crypto';
import { SdmConfiguration, sdmUri } from '../../bounded-contexts/traceability/domain/sdm';
import { SealedSdmKeys } from '../../bounded-contexts/traceability/application/sdm-ports';
import { createDataSource } from '../database/data-source';
import { loadSdmEnv } from './sdm-env';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
}
// Deliberately constrained to the ignored private directory, exclusive create, owner-only access.
export function privateOutput(name: string, value: string): string {
  const root = resolve('.tmp/private');
  mkdirSync(root, { recursive: true });
  const target = resolve(name);
  const path = relative(root, target);
  if (
    !path ||
    path.startsWith('..') ||
    isAbsolute(path) ||
    dirname(target) !== root ||
    realpathSync(root) !== root
  )
    throw new Error('Output must be a new file directly inside .tmp/private');
  const fd = openSync(target, 'wx', 0o600);
  try {
    if (process.platform === 'win32') {
      const owner = execFileSync('whoami', [], { encoding: 'utf8', windowsHide: true }).trim();
      execFileSync('icacls', [target, '/inheritance:r', '/grant:r', `${owner}:(F)`], {
        stdio: 'ignore',
        windowsHide: true,
      });
    }
    writeFileSync(fd, value);
  } finally {
    closeSync(fd);
  }
  return target;
}

async function main() {
  loadEnv({ quiet: true });
  const action = process.argv[2];
  if (action === 'generate-master') {
    const version = option('version') ?? '1';
    const output = option('output');
    if (!/^[1-9][0-9]{0,8}$/.test(version) || !output)
      throw new Error('Use generate-master --version 1 --output .tmp/private/sdm-master.env');
    const ring = JSON.stringify({ [version]: randomBytes(32).toString('base64') });
    const filename = privateOutput(
      output,
      `SDM_ACTIVE_MASTER_VERSION=${version}\nSDM_MASTER_KEYS_JSON='${ring}'\n`,
    );
    process.stdout.write(`Private master configuration created: ${filename}\n`);
    return;
  }
  if (action !== 'export' && action !== 'rewrap')
    throw new Error(
      'Use generate-master, export --provisioning-id UUID --output .tmp/private/tag.json, or rewrap',
    );
  loadSdmEnv();
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const vault = new NodeSdmCryptography(
    process.env.SDM_ACTIVE_MASTER_VERSION,
    process.env.SDM_MASTER_KEYS_JSON,
  );
  const source = await createDataSource(process.env.DATABASE_URL).initialize();
  try {
    if (action === 'export') {
      const id = option('provisioning-id');
      const output = option('output');
      if (!id || !/^[0-9a-f-]{36}$/.test(id) || !output)
        throw new Error('Use export --provisioning-id UUID --output .tmp/private/tag.json');
      await source.transaction(async (manager) => {
        const rows: { id: string; status: string; sdm: SdmConfiguration; sealed: SealedSdmKeys }[] =
          await manager.query(
            'SELECT p.id,p.status,p.sdm,k.sealed FROM provisionings p JOIN sdm_keys k ON k.provisioning_id=p.id WHERE p.id=$1 FOR UPDATE OF p,k',
            [id],
          );
        const row = rows[0];
        if (!row || row.status !== 'REGISTRADA')
          throw new Error('Only a pending SDM provisioning can be exported for personalization');
        const keys = vault.unseal(id, row.sdm, row.sealed);
        try {
          const filename = privateOutput(
            output,
            JSON.stringify(
              {
                provisionamentoId: id,
                perfil: row.sdm.profile,
                referenciaChaves: row.sdm.keyReference,
                versaoChaves: row.sdm.keyVersion,
                uriTemplate: sdmUri(id),
                metaRead: { slot: 1, keyHex: keys.subarray(0, 16).toString('hex') },
                fileRead: { slot: 2, keyHex: keys.subarray(16).toString('hex') },
              },
              null,
              2,
            ) + '\n',
          );
          process.stdout.write(`Private personalization material created: ${filename}\n`);
        } finally {
          keys.fill(0);
        }
        const eventId = randomUUID();
        await manager.query(
          'INSERT INTO outbox (id,envelope,created_at) VALUES ($1,$2,clock_timestamp())',
          [
            eventId,
            JSON.stringify({
              id: eventId,
              type: 'ChavesSdmExportadas',
              version: 1,
              aggregateId: id,
              occurredAt: new Date().toISOString(),
              correlationId: randomUUID(),
              causationId: null,
              payload: { origem: 'CLI_LOCAL', referenciaChaves: row.sdm.keyReference },
            }),
          ],
        );
      });
    } else {
      const count = await source.transaction(async (manager) => {
        const rows: { id: string; sdm: SdmConfiguration; sealed: SealedSdmKeys }[] =
          await manager.query(
            'SELECT p.id,p.sdm,k.sealed FROM provisionings p JOIN sdm_keys k ON k.provisioning_id=p.id ORDER BY p.id FOR UPDATE OF k',
          );
        for (const row of rows) {
          const sealed = vault.rewrap(row.id, row.sdm, row.sealed);
          await manager.query('UPDATE sdm_keys SET sealed=$2 WHERE provisioning_id=$1', [
            row.id,
            JSON.stringify(sealed),
          ]);
          const eventId = randomUUID();
          await manager.query(
            'INSERT INTO outbox (id,envelope,created_at) VALUES ($1,$2,clock_timestamp())',
            [
              eventId,
              JSON.stringify({
                id: eventId,
                type: 'CofreSdmRotacionado',
                version: 1,
                aggregateId: row.id,
                occurredAt: new Date().toISOString(),
                correlationId: randomUUID(),
                causationId: null,
                payload: {
                  origem: 'CLI_LOCAL',
                  referenciaChaves: row.sdm.keyReference,
                  versaoAnterior: row.sealed.masterVersion,
                  versaoAtual: sealed.masterVersion,
                },
              }),
            ],
          );
        }
        return rows.length;
      });
      process.stdout.write(
        `Vault rewrapped atomically: ${count} provisionings. Tag keys and counters retained.\n`,
      );
    }
  } finally {
    await source.destroy();
  }
}
if (require.main === module)
  void main().catch(() => {
    // Never echo configuration, decrypted values or exception arguments.
    process.stderr.write(
      'SDM administration failed. Check the command, private path, database and master versions.\n',
    );
    process.exitCode = 1;
  });
