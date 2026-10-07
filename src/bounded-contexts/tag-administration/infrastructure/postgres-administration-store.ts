import { DataSource, EntityManager } from 'typeorm';
import { DomainError } from '../../../shared-kernel/domain-error';
import { EventEnvelope } from '../../../shared-kernel/events';
import { AccessError, AuthenticatedActor } from '../../../shared-kernel/actor';
import { InspectionSnapshot } from '../domain/inspection';
import {
  AdministrationStore,
  AdministrationTransaction,
  CredentialRecord,
  JournalEntry,
  ProvisioningGate,
  ResponseRecord,
  SessionRecord,
} from '../application/ports';

class PostgresAdministrationTransaction implements AdministrationTransaction {
  constructor(private readonly manager: EntityManager) {}
  async authorize(actor: AuthenticatedActor, now: string): Promise<void> {
    const accounts: { active: boolean; role: string }[] = await this.manager.query(
      'SELECT active,role FROM identity_accounts WHERE id=$1 FOR SHARE',
      [actor.userId],
    );
    const sessions: { expires_at: Date; revoked_at: Date | null }[] = await this.manager.query(
      'SELECT expires_at,revoked_at FROM identity_sessions WHERE id=$1 AND user_id=$2 FOR SHARE',
      [actor.sessionId, actor.userId],
    );
    if (
      !accounts[0]?.active ||
      accounts[0].role !== 'ADMINISTRADOR' ||
      !sessions[0] ||
      sessions[0].revoked_at ||
      sessions[0].expires_at.toISOString() <= now
    )
      throw new AccessError(
        'NFC_PERMISSAO_REVOGADA',
        'A sessão administrativa não está mais autorizada.',
        'forbidden',
      );
  }
  async lockUid(uid: string): Promise<void> {
    await this.manager.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('nfc-admin:uid:' || $1,0))",
      [uid],
    );
  }
  async credential(uid: string): Promise<CredentialRecord | null> {
    const rows: CredentialRecord[] = await this.manager.query(
      `SELECT c.id,c.uid,c.versions,c.sealed,c.created_at AS "createdAt"
      FROM nfc_inventory i JOIN nfc_credentials c ON c.id=i.credential_id WHERE i.uid=$1`,
      [uid],
    );
    return rows[0] ? { ...rows[0], createdAt: new Date(rows[0].createdAt).toISOString() } : null;
  }
  async importCredential(c: CredentialRecord): Promise<void> {
    await this.manager.query(
      'INSERT INTO nfc_credentials(id,uid,versions,sealed,created_at) VALUES($1,$2,$3,$4,$5)',
      [c.id, c.uid, JSON.stringify(c.versions), JSON.stringify(c.sealed), c.createdAt],
    );
    await this.manager.query(
      'INSERT INTO nfc_inventory(uid,credential_id) VALUES($1,$2) ON CONFLICT(uid) DO UPDATE SET credential_id=EXCLUDED.credential_id',
      [c.uid, c.id],
    );
  }
  async openByUid(uid: string): Promise<InspectionSnapshot | null> {
    const rows: { id: string }[] = await this.manager.query(
      "SELECT id FROM nfc_inspections WHERE uid=$1 AND state<>'ENCERRADA'",
      [uid],
    );
    // The UID advisory lock is the serialization point; avoid a second operation lock.
    return rows[0] ? this.readOperation(rows[0].id) : null;
  }
  async provisioning(id: string): Promise<ProvisioningGate | null> {
    // ACL: lock order before binding, following traceability's transaction ordering.
    const ids: { order_id: string }[] = await this.manager.query(
      'SELECT order_id FROM provisionings WHERE id=$1',
      [id],
    );
    if (!ids[0]) return null;
    await this.manager.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE', [ids[0].order_id]);
    const rows: ProvisioningGate[] = await this.manager.query(
      `SELECT p.id,t.uid,t.model,p.epoch,p.strategy,p.status
      FROM provisionings p JOIN tags t ON t.id=p.tag_id WHERE p.id=$1 FOR UPDATE OF p`,
      [id],
    );
    return rows[0] ?? null;
  }
  private async readOperation(id: string): Promise<InspectionSnapshot | null> {
    const rows: InspectionSnapshot[] = await this.manager.query(
      `SELECT id,plan,plan_hash AS "planHash",actor_id AS "actorId",station,state,
      created_at AS "createdAt",active_session AS "activeSession" FROM nfc_inspections WHERE id=$1`,
      [id],
    );
    return rows[0] ? { ...rows[0], createdAt: new Date(rows[0].createdAt).toISOString() } : null;
  }
  async operation(id: string): Promise<InspectionSnapshot | null> {
    await this.manager.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('nfc-admin:operation:' || $1,0))",
      [id],
    );
    return this.readOperation(id);
  }
  async saveOperation(s: InspectionSnapshot): Promise<void> {
    await this.manager.query(
      `INSERT INTO nfc_inspections(id,provisioning_id,uid,credential_id,actor_id,station,plan,plan_hash,state,created_at,active_session)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(id) DO UPDATE SET state=EXCLUDED.state,active_session=EXCLUDED.active_session`,
      [
        s.id,
        s.plan.provisioningId,
        s.plan.uid,
        s.plan.credentialReference,
        s.actorId,
        s.station,
        JSON.stringify(s.plan),
        s.planHash,
        s.state,
        s.createdAt,
        s.activeSession,
      ],
    );
  }
  async session(id: string): Promise<SessionRecord | null> {
    const rows: SessionRecord[] = await this.manager.query(
      `SELECT id,operation_id AS "operationId",rf_session_id AS "rfSessionId",
      identity_session_id AS "identitySessionId",fingerprint,expires_at AS "expiresAt",reply FROM nfc_admin_sessions WHERE id=$1`,
      [id],
    );
    return rows[0] ? { ...rows[0], expiresAt: new Date(rows[0].expiresAt).toISOString() } : null;
  }
  async saveSession(s: SessionRecord): Promise<void> {
    await this.manager.query(
      `INSERT INTO nfc_admin_sessions(id,operation_id,rf_session_id,identity_session_id,fingerprint,expires_at,reply)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET reply=EXCLUDED.reply`,
      [
        s.id,
        s.operationId,
        s.rfSessionId,
        s.identitySessionId,
        s.fingerprint,
        s.expiresAt,
        JSON.stringify(s.reply),
      ],
    );
  }
  async response(commandId: string): Promise<ResponseRecord | null> {
    const rows: ResponseRecord[] = await this.manager.query(
      'SELECT command_id AS "commandId",fingerprint,reply FROM nfc_admin_responses WHERE command_id=$1',
      [commandId],
    );
    return rows[0] ?? null;
  }
  async saveResponse(r: ResponseRecord): Promise<void> {
    await this.manager.query(
      'INSERT INTO nfc_admin_responses(command_id,fingerprint,reply) VALUES($1,$2,$3)',
      [r.commandId, r.fingerprint, JSON.stringify(r.reply)],
    );
  }
  async append(e: JournalEntry): Promise<void> {
    await this.manager.query(
      'INSERT INTO nfc_admin_journal(id,operation_id,session_id,type,occurred_at,details) VALUES($1,$2,$3,$4,$5,$6)',
      [e.id, e.operationId, e.sessionId, e.type, e.occurredAt, JSON.stringify(e.details)],
    );
  }
  async journal(operationId: string, page: number, limit: number) {
    const items: JournalEntry[] = await this.manager.query(
      `SELECT id,operation_id AS "operationId",session_id AS "sessionId",type,
      occurred_at AS "occurredAt",details FROM nfc_admin_journal WHERE operation_id=$1 ORDER BY sequence LIMIT $2 OFFSET $3`,
      [operationId, limit, (page - 1) * limit],
    );
    const rows: { n: number }[] = await this.manager.query(
      'SELECT count(*)::int AS n FROM nfc_admin_journal WHERE operation_id=$1',
      [operationId],
    );
    return {
      items: items.map((e) => ({ ...e, occurredAt: new Date(e.occurredAt).toISOString() })),
      total: rows[0]!.n,
    };
  }
  async publish(e: EventEnvelope): Promise<void> {
    await this.manager.query('INSERT INTO outbox(id,envelope,created_at) VALUES($1,$2,$3)', [
      e.id,
      JSON.stringify(e),
      e.occurredAt,
    ]);
  }
}
export class PostgresAdministrationStore implements AdministrationStore {
  constructor(private readonly source: DataSource) {}
  async run<T>(work: (tx: AdministrationTransaction) => Promise<T>): Promise<T> {
    try {
      return await this.source.transaction((manager) =>
        work(new PostgresAdministrationTransaction(manager)),
      );
    } catch (error) {
      const code = (error as { driverError?: { code?: string } }).driverError?.code;
      if (code === '23505')
        throw new DomainError(
          'NFC_OPERACAO_CONCORRENTE',
          'Já existe operação, sessão RF ou resposta com esta identidade.',
          'conflict',
        );
      throw error;
    }
  }
}
