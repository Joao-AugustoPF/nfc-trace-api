import { MigrationInterface, QueryRunner } from 'typeorm';

export class NfcPersonalization1790000006000 implements MigrationInterface {
  name = 'NfcPersonalization1790000006000';
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      CREATE TABLE nfc_credential_wrappers (
        sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        id uuid UNIQUE NOT NULL, credential_id uuid NOT NULL REFERENCES nfc_credentials(id),
        sealed jsonb NOT NULL, created_at timestamptz NOT NULL
      );
      CREATE INDEX nfc_wrapper_latest ON nfc_credential_wrappers(credential_id,sequence DESC);
      CREATE TRIGGER immutable_nfc_wrapper BEFORE UPDATE OR DELETE ON nfc_credential_wrappers
        FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
      CREATE TABLE nfc_personalization_targets (
        provisioning_id uuid PRIMARY KEY REFERENCES provisionings(id),
        operation_id uuid UNIQUE NOT NULL REFERENCES nfc_inspections(id),
        credential_id uuid UNIQUE NOT NULL REFERENCES nfc_credentials(id)
      );
      CREATE TRIGGER immutable_nfc_target BEFORE UPDATE OR DELETE ON nfc_personalization_targets
        FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
      ALTER TABLE nfc_inspections DROP CONSTRAINT nfc_inspections_state_check;
      ALTER TABLE nfc_inspections DROP CONSTRAINT nfc_inspections_check;
      ALTER TABLE nfc_inspections ADD CHECK(state IN ('PREPARADA','INSPECIONANDO','INSPECIONADA','PERSONALIZANDO','PERSONALIZADA','INTERROMPIDA','ENCERRADA'));
      ALTER TABLE nfc_inspections ADD CHECK((state IN ('INSPECIONANDO','PERSONALIZANDO'))=(active_session IS NOT NULL));
      ALTER TABLE nfc_inspections ADD mutation_issued boolean NOT NULL DEFAULT false;
      ALTER TABLE nfc_inspections ADD data_verified boolean NOT NULL DEFAULT false;
      ALTER TABLE nfc_inspections ADD physical_outcome varchar NOT NULL DEFAULT 'NAO_ALTERADA'
        CHECK(physical_outcome IN ('NAO_ALTERADA','NAO_CONFIRMADA','CONFERIDA'));
      ALTER TABLE nfc_inspections ADD CHECK(NOT mutation_issued OR physical_outcome<>'NAO_ALTERADA');
      ALTER TABLE nfc_inspections ADD CHECK(physical_outcome<>'CONFERIDA' OR data_verified);
      ALTER TABLE nfc_inspections ADD CHECK(state<>'PERSONALIZADA' OR physical_outcome='CONFERIDA');
      ALTER TABLE nfc_admin_journal DROP CONSTRAINT nfc_admin_journal_type_check;
      ALTER TABLE nfc_admin_journal ADD CHECK(type IN ('PREPARADA','INTENCAO','RESPOSTA','INTERROMPIDA','INSPECIONADA','PERSONALIZADA','DADOS_CONFERIDOS','ENCERRADA'));
      CREATE OR REPLACE FUNCTION preserve_nfc_inspection_plan() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (NEW.id,NEW.provisioning_id,NEW.uid,NEW.credential_id,NEW.actor_id,NEW.station,NEW.plan,NEW.plan_hash,NEW.created_at)
          IS DISTINCT FROM (OLD.id,OLD.provisioning_id,OLD.uid,OLD.credential_id,OLD.actor_id,OLD.station,OLD.plan,OLD.plan_hash,OLD.created_at)
          OR (OLD.state='ENCERRADA' AND NEW.state<>'ENCERRADA')
          OR (OLD.mutation_issued AND NOT NEW.mutation_issued)
          OR (OLD.physical_outcome='CONFERIDA' AND NEW.physical_outcome<>'CONFERIDA')
          OR (OLD.state IN ('INSPECIONADA','PERSONALIZADA') AND NEW.state NOT IN (OLD.state,'ENCERRADA'))
          OR (NEW.state='ENCERRADA' AND NEW.mutation_issued AND NEW.physical_outcome<>'CONFERIDA') THEN
          RAISE EXCEPTION 'NFC operation plan and confirmed history are immutable' USING ERRCODE='23514';
        END IF; RETURN NEW;
      END; $$;
    `);
  }
  async down(): Promise<void> {
    throw new Error('NFC personalization vault/journal migration is forward-only');
  }
}
