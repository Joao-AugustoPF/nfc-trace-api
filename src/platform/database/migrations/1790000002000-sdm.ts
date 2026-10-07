import { MigrationInterface, QueryRunner } from 'typeorm';

export class Sdm1790000002000 implements MigrationInterface {
  name = 'Sdm1790000002000';
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      ALTER TABLE provisionings DROP CONSTRAINT provisionings_strategy_check;
      ALTER TABLE provisionings ADD CHECK (strategy IN ('UID','NDEF_ESTATICO','SDM'));
      ALTER TABLE observations DROP CONSTRAINT observations_strategy_check;
      ALTER TABLE observations ADD CHECK (strategy IN ('UID','NDEF_ESTATICO','SDM'));
      ALTER TABLE provisionings ADD COLUMN sdm jsonb;
      ALTER TABLE provisionings ADD CONSTRAINT sdm_configuration CHECK (
        (strategy <> 'SDM' AND sdm IS NULL) OR (strategy = 'SDM' AND sdm IS NOT NULL AND
        (sdm->>'profile' = 'nfc-trace.sdm.encrypted-picc.v1' AND
         sdm->>'policy' IN ('ESTRITA','REGISTRO_TARDIO') AND
         sdm->>'keyVersion' = '1' AND (sdm->>'keyReference')::uuid IS NOT NULL) IS TRUE));
      CREATE FUNCTION preserve_sdm_configuration() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.sdm IS DISTINCT FROM OLD.sdm THEN
          RAISE EXCEPTION 'SDM configuration is immutable' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER immutable_sdm_configuration BEFORE UPDATE ON provisionings
        FOR EACH ROW EXECUTE FUNCTION preserve_sdm_configuration();
      CREATE TABLE sdm_keys (
        provisioning_id uuid PRIMARY KEY REFERENCES provisionings(id),
        sealed jsonb NOT NULL,
        CHECK (jsonb_typeof(sealed) = 'object' AND
          sealed ?& ARRAY['masterVersion','nonce','ciphertext','authenticationTag'])
      );
      CREATE TABLE sdm_counter_state (
        provisioning_id uuid PRIMARY KEY REFERENCES sdm_keys(provisioning_id),
        maximum integer NOT NULL DEFAULT -1 CHECK (maximum BETWEEN -1 AND 16777215)
      );
      CREATE TABLE sdm_evidence (
        provisioning_id uuid NOT NULL REFERENCES sdm_counter_state(provisioning_id),
        counter integer NOT NULL CHECK (counter BETWEEN 0 AND 16777215),
        observation_id uuid UNIQUE REFERENCES observations(id) DEFERRABLE INITIALLY DEFERRED,
        received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (provisioning_id, counter)
      );
      CREATE UNIQUE INDEX sdm_activation_evidence ON sdm_evidence(provisioning_id) WHERE observation_id IS NULL;
      CREATE TRIGGER immutable_sdm_evidence BEFORE UPDATE OR DELETE ON sdm_evidence
        FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
      CREATE FUNCTION preserve_sdm_maximum() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.provisioning_id <> OLD.provisioning_id OR NEW.maximum < OLD.maximum THEN
          RAISE EXCEPTION 'SDM high-water mark cannot regress' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER monotonic_sdm_counter BEFORE UPDATE ON sdm_counter_state
        FOR EACH ROW EXECUTE FUNCTION preserve_sdm_maximum();
    `);
  }
  async down(runner: QueryRunner): Promise<void> {
    // Do not destroy evidence or downgrade an existing SDM epoch.
    const rows: { count: string }[] = await runner.query(
      "SELECT count(*) FROM provisionings WHERE strategy = 'SDM'",
    );
    if (Number(rows[0]!.count))
      throw new Error('Cannot downgrade a database containing SDM epochs');
    await runner.query(`
      DROP TABLE sdm_evidence, sdm_counter_state, sdm_keys;
      DROP FUNCTION preserve_sdm_maximum();
      DROP TRIGGER immutable_sdm_configuration ON provisionings;
      DROP FUNCTION preserve_sdm_configuration();
      ALTER TABLE provisionings DROP COLUMN sdm;
      ALTER TABLE provisionings DROP CONSTRAINT provisionings_strategy_check;
      ALTER TABLE provisionings ADD CHECK (strategy IN ('UID','NDEF_ESTATICO'));
      ALTER TABLE observations DROP CONSTRAINT observations_strategy_check;
      ALTER TABLE observations ADD CHECK (strategy IN ('UID','NDEF_ESTATICO'));
    `);
  }
}
