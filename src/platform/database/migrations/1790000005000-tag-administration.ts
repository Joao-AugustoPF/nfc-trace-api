import { MigrationInterface, QueryRunner } from 'typeorm';

export class TagAdministration1790000005000 implements MigrationInterface {
  name = 'TagAdministration1790000005000';
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      CREATE FUNCTION nfc_valid_versions(v jsonb) RETURNS boolean IMMUTABLE LANGUAGE sql AS $$
        SELECT CASE WHEN jsonb_typeof(v)='array' THEN jsonb_array_length(v)=5 AND NOT EXISTS(
          SELECT 1 FROM jsonb_array_elements(v) e WHERE jsonb_typeof(e)<>'number' OR e::text !~ '^[0-9]{1,3}$' OR e::text::numeric>255)
          ELSE false END;
      $$;
      CREATE TABLE nfc_credentials (
        id uuid PRIMARY KEY, uid varchar(14) NOT NULL CHECK(uid ~ '^[0-9A-F]{14}$'),
        versions jsonb NOT NULL CHECK(nfc_valid_versions(versions)), sealed jsonb NOT NULL,
        created_at timestamptz NOT NULL, UNIQUE(id,uid)
      );
      CREATE TABLE nfc_inventory (
        uid varchar(14) PRIMARY KEY, credential_id uuid NOT NULL,
        FOREIGN KEY(credential_id,uid) REFERENCES nfc_credentials(id,uid)
      );
      CREATE TABLE nfc_inspections (
        id uuid PRIMARY KEY, provisioning_id uuid NOT NULL REFERENCES provisionings(id),
        uid varchar(14) NOT NULL, credential_id uuid NOT NULL,
        actor_id uuid NOT NULL REFERENCES identity_accounts(id), station varchar(128) NOT NULL,
        plan jsonb NOT NULL, plan_hash varchar(64) NOT NULL,
        state varchar NOT NULL CHECK(state IN ('PREPARADA','INSPECIONANDO','INSPECIONADA','INTERROMPIDA','ENCERRADA')),
        created_at timestamptz NOT NULL, active_session uuid,
        FOREIGN KEY(credential_id,uid) REFERENCES nfc_credentials(id,uid),
        CHECK((state='INSPECIONANDO')=(active_session IS NOT NULL))
      );
      CREATE UNIQUE INDEX nfc_open_inspection ON nfc_inspections(uid) WHERE state<>'ENCERRADA';
      CREATE TABLE nfc_admin_sessions (
        id uuid PRIMARY KEY, operation_id uuid NOT NULL REFERENCES nfc_inspections(id),
        rf_session_id uuid NOT NULL UNIQUE, identity_session_id uuid NOT NULL REFERENCES identity_sessions(id),
        fingerprint varchar(64) NOT NULL, expires_at timestamptz NOT NULL, reply jsonb NOT NULL,
        UNIQUE(id,operation_id)
      );
      ALTER TABLE nfc_inspections ADD FOREIGN KEY(active_session,id)
        REFERENCES nfc_admin_sessions(id,operation_id) DEFERRABLE INITIALLY DEFERRED;
      CREATE TABLE nfc_admin_journal (
        sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        id uuid UNIQUE NOT NULL, operation_id uuid NOT NULL REFERENCES nfc_inspections(id),
        session_id uuid, type varchar NOT NULL CHECK(type IN ('PREPARADA','INTENCAO','RESPOSTA','INTERROMPIDA','INSPECIONADA','ENCERRADA')),
        occurred_at timestamptz NOT NULL, details jsonb NOT NULL,
        FOREIGN KEY(session_id,operation_id) REFERENCES nfc_admin_sessions(id,operation_id)
      );
      CREATE INDEX nfc_journal_operation ON nfc_admin_journal(operation_id,sequence);
      CREATE TABLE nfc_admin_responses (
        command_id uuid PRIMARY KEY REFERENCES nfc_admin_journal(id),
        fingerprint varchar(64) NOT NULL, reply jsonb NOT NULL
      );
      CREATE TRIGGER immutable_nfc_credentials BEFORE UPDATE OR DELETE ON nfc_credentials
        FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
      CREATE TRIGGER immutable_nfc_journal BEFORE UPDATE OR DELETE ON nfc_admin_journal
        FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
      CREATE TRIGGER immutable_nfc_response BEFORE UPDATE OR DELETE ON nfc_admin_responses
        FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
      CREATE FUNCTION preserve_nfc_inspection_plan() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (NEW.id,NEW.provisioning_id,NEW.uid,NEW.credential_id,NEW.actor_id,NEW.station,NEW.plan,NEW.plan_hash,NEW.created_at)
          IS DISTINCT FROM (OLD.id,OLD.provisioning_id,OLD.uid,OLD.credential_id,OLD.actor_id,OLD.station,OLD.plan,OLD.plan_hash,OLD.created_at)
          OR (OLD.state='ENCERRADA' AND NEW.state<>'ENCERRADA') THEN
          RAISE EXCEPTION 'NFC inspection plan is immutable' USING ERRCODE='23514';
        END IF; RETURN NEW;
      END; $$;
      CREATE TRIGGER immutable_nfc_plan BEFORE UPDATE ON nfc_inspections
        FOR EACH ROW EXECUTE FUNCTION preserve_nfc_inspection_plan();
      CREATE FUNCTION preserve_nfc_session() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (NEW.id,NEW.operation_id,NEW.rf_session_id,NEW.identity_session_id,NEW.fingerprint,NEW.expires_at)
          IS DISTINCT FROM (OLD.id,OLD.operation_id,OLD.rf_session_id,OLD.identity_session_id,OLD.fingerprint,OLD.expires_at) THEN
          RAISE EXCEPTION 'NFC session identity and lease are immutable' USING ERRCODE='23514';
        END IF; RETURN NEW;
      END; $$;
      CREATE TRIGGER immutable_nfc_session BEFORE UPDATE ON nfc_admin_sessions
        FOR EACH ROW EXECUTE FUNCTION preserve_nfc_session();
    `);
  }
  async down(runner: QueryRunner): Promise<void> {
    const rows: { n: string }[] = await runner.query('SELECT count(*) AS n FROM nfc_credentials');
    if (Number(rows[0]!.n)) throw new Error('Cannot remove a vault containing NFC credentials');
    await runner.query(`ALTER TABLE nfc_inspections DROP CONSTRAINT nfc_inspections_active_session_id_fkey;
      DROP TABLE nfc_admin_responses,nfc_admin_journal,nfc_admin_sessions,nfc_inspections,nfc_inventory,nfc_credentials;
      DROP FUNCTION preserve_nfc_inspection_plan(),preserve_nfc_session();
      DROP FUNCTION IF EXISTS nfc_valid_versions(jsonb);`);
  }
}
