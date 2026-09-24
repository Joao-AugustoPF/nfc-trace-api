import { DataSource } from 'typeorm';
import { createDataSource } from '../src/platform/database/data-source';
import { randomUUID } from 'node:crypto';
import { Role } from '../src/shared-kernel/actor';
import {
  OpaqueTokens,
  ScryptPasswords,
} from '../src/bounded-contexts/identity/infrastructure/crypto';

export async function testDatabase(): Promise<DataSource> {
  const url =
    process.env.TEST_DATABASE_URL ??
    'postgresql://nfc_trace:nfc_trace_local@localhost:55432/nfc_trace_test';
  if (!new URL(url).pathname.endsWith('_test'))
    throw new Error('Integration database name MUST end in _test');
  const source = await createDataSource(url).initialize();
  await source.runMigrations({ transaction: 'all' });
  return source;
}

export async function resetDatabase(source: DataSource): Promise<void> {
  await source.query(
    'TRUNCATE security_audit, identity_login_limits, identity_sessions, identity_accounts, audit_log, inbox, outbox, movements, decisions, observations, provisionings, tags, orders',
  );
}

export const testPassword = 'Laboratorio-Teste-2026';
let passwordHash: Promise<string> | undefined;
export async function seedIdentity(
  source: DataSource,
  role: Role = 'ADMINISTRADOR',
  login = `user-${randomUUID()}`,
) {
  const id = randomUUID();
  const sessionId = randomUUID();
  const crypto = new OpaqueTokens();
  const token = crypto.issue();
  const hash = await (passwordHash ??= new ScryptPasswords().hash(testPassword));
  await source.query(
    'INSERT INTO identity_accounts (id,login,name,role,password_hash) VALUES ($1,$2,$3,$4,$5)',
    [id, login, login, role, hash],
  );
  await source.query(
    "INSERT INTO identity_sessions (id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,clock_timestamp()+interval '1 hour')",
    [sessionId, id, crypto.digest(token)],
  );
  return { id, login, token, sessionId, role };
}
