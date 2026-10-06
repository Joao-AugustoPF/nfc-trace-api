import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { DomainError } from '../../../shared-kernel/domain-error';
import { IdentityStore, IdentityTransaction, SecurityEvent } from '../application/ports';
import { Account } from '../domain/account';

const accountColumns = 'id, login, name, role, password_hash AS "passwordHash", active';
async function audit(manager: EntityManager, event: SecurityEvent) {
  const id = randomUUID();
  const now = new Date().toISOString();
  await manager.query(
    'INSERT INTO security_audit (id,event_type,actor,subject_id,outcome,reason,route,correlation_id,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [
      id,
      event.type,
      event.actor,
      event.subjectId ?? null,
      event.outcome,
      event.reason ?? null,
      event.route ?? null,
      event.correlationId,
      now,
    ],
  );
  const envelope = {
    id,
    type: event.type,
    version: 1,
    aggregateId: event.subjectId ?? event.actor?.userId ?? id,
    occurredAt: now,
    correlationId: event.correlationId,
    causationId: null,
    payload: {
      atorAutenticado: event.actor,
      resultado: event.outcome,
      motivo: event.reason ?? null,
      rota: event.route ?? null,
    },
  };
  await manager.query('INSERT INTO outbox (id,envelope,created_at) VALUES ($1,$2,$3)', [
    id,
    envelope,
    now,
  ]);
}
function transaction(manager: EntityManager): IdentityTransaction {
  return {
    accounts: {
      async byLogin(login) {
        const rows: Account[] = await manager.query(
          `SELECT ${accountColumns} FROM identity_accounts WHERE login=$1 FOR UPDATE`,
          [login],
        );
        return rows[0] ?? null;
      },
      async get(id) {
        const rows: Account[] = await manager.query(
          `SELECT ${accountColumns} FROM identity_accounts WHERE id=$1 FOR UPDATE`,
          [id],
        );
        return rows[0] ?? null;
      },
      async insert(a) {
        await manager.query(
          'INSERT INTO identity_accounts (id,login,name,role,password_hash,active) VALUES ($1,$2,$3,$4,$5,$6)',
          [a.id, a.login, a.name, a.role, a.passwordHash, a.active],
        );
      },
      async disable(id) {
        await manager.query('UPDATE identity_accounts SET active=false WHERE id=$1', [id]);
      },
      async lockBootstrap() {
        await manager.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('identity:bootstrap',0))",
        );
      },
      async count() {
        const rows: { count: string }[] = await manager.query(
          'SELECT count(*) FROM identity_accounts',
        );
        return Number(rows[0]!.count);
      },
    },
    sessions: {
      async insert(s) {
        await manager.query(
          'INSERT INTO identity_sessions (id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,$4)',
          [s.id, s.userId, s.tokenHash, s.expiresAt],
        );
      },
      async revoke(id, userId) {
        await manager.query(
          'UPDATE identity_sessions SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=$1 AND user_id=$2',
          [id, userId],
        );
      },
      async revokeAll(userId) {
        await manager.query(
          'UPDATE identity_sessions SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE user_id=$1',
          [userId],
        );
      },
    },
    audit: (event) => audit(manager, event),
  };
}
export class PostgresIdentityStore implements IdentityStore {
  constructor(private readonly source: DataSource) {}
  async run<T>(work: (tx: IdentityTransaction) => Promise<T>) {
    try {
      return await this.source.transaction((manager) => work(transaction(manager)));
    } catch (error) {
      if (
        error instanceof QueryFailedError &&
        (error.driverError as { code?: string }).code === '23505'
      )
        throw new DomainError('LOGIN_DUPLICADO', 'Login já utilizado.', 'conflict');
      throw error;
    }
  }
  async accountByLogin(login: string) {
    const rows: Account[] = await this.source.query(
      `SELECT ${accountColumns} FROM identity_accounts WHERE login=$1`,
      [login],
    );
    return rows[0] ?? null;
  }
  async session(tokenHash: string) {
    const rows: (Account & { sessionId: string; expiresAt: Date })[] = await this.source.query(
      `SELECT a.id,a.login,a.name,a.role,a.password_hash AS "passwordHash",a.active,
        s.id AS "sessionId",s.expires_at AS "expiresAt"
       FROM identity_sessions s JOIN identity_accounts a ON a.id=s.user_id
       WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp() AND a.active`,
      [tokenHash],
    );
    const row = rows[0];
    return row
      ? {
          account: row,
          session: {
            id: row.sessionId,
            userId: row.id,
            tokenHash,
            expiresAt: row.expiresAt.toISOString(),
          },
        }
      : null;
  }
  async consumeLoginAttempt(login: string, address: string) {
    const limits = [
      { key: 'login:' + login, max: 10 },
      { key: 'address:' + address, max: 60 },
    ]
      .map((x) => ({ ...x, key: createHash('sha256').update(x.key).digest('hex') }))
      .sort((a, b) => a.key.localeCompare(b.key));
    return this.source.transaction(async (manager) => {
      let allowed = true;
      for (const limit of limits) {
        const rows: { attempts: number }[] = await manager.query(
          `
          INSERT INTO identity_login_limits (key,attempts,window_start) VALUES ($1,1,clock_timestamp())
          ON CONFLICT (key) DO UPDATE SET
            attempts = CASE WHEN identity_login_limits.window_start <= clock_timestamp() - interval '15 minutes'
              THEN 1 ELSE LEAST(identity_login_limits.attempts + 1, 1000) END,
            window_start = CASE WHEN identity_login_limits.window_start <= clock_timestamp() - interval '15 minutes'
              THEN clock_timestamp() ELSE identity_login_limits.window_start END
          RETURNING attempts`,
          [limit.key],
        );
        if (rows[0]!.attempts > limit.max) allowed = false;
      }
      return allowed;
    });
  }
  async audit(event: SecurityEvent) {
    await this.source.transaction((manager) => audit(manager, event));
  }
}
