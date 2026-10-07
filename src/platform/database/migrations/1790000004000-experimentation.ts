import { MigrationInterface, QueryRunner } from 'typeorm';

export class Experimentation1790000004000 implements MigrationInterface {
  name = 'Experimentation1790000004000';
  async up(r: QueryRunner) {
    await r.query(`
      CREATE TABLE experiment_runs (id uuid PRIMARY KEY,input jsonb NOT NULL,fingerprint char(64) NOT NULL,user_id uuid NOT NULL REFERENCES identity_accounts(id),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp());
      CREATE TABLE experiment_trials (id uuid PRIMARY KEY,run_id uuid NOT NULL REFERENCES experiment_runs(id),session_id uuid NOT NULL,provisioning_id uuid NOT NULL REFERENCES provisionings(id),ordinal integer NOT NULL CHECK(ordinal>0),input jsonb NOT NULL,fingerprint char(64) NOT NULL,user_id uuid NOT NULL REFERENCES identity_accounts(id),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(run_id,session_id,ordinal));
      CREATE INDEX experiment_run_trials ON experiment_trials(run_id,session_id,ordinal);
      CREATE TABLE experiment_ground_truth (id uuid PRIMARY KEY,trial_id uuid NOT NULL REFERENCES experiment_trials(id),revision integer NOT NULL CHECK(revision>0),input jsonb NOT NULL,fingerprint char(64) NOT NULL,user_id uuid NOT NULL REFERENCES identity_accounts(id),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(trial_id,revision));
      CREATE TABLE experiment_client_records (id uuid PRIMARY KEY,trial_id uuid NOT NULL REFERENCES experiment_trials(id),attempt_id uuid NOT NULL,observation_id uuid,input jsonb NOT NULL,fingerprint char(64) NOT NULL,user_id uuid NOT NULL REFERENCES identity_accounts(id),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp());
      CREATE INDEX experiment_attempts ON experiment_client_records(trial_id,attempt_id,recorded_at,id);
      CREATE INDEX experiment_capture_links ON experiment_client_records(observation_id) WHERE observation_id IS NOT NULL;
      CREATE TABLE operation_measurements (
        observation_id uuid NOT NULL,revision integer NOT NULL,boundary varchar NOT NULL CHECK(boundary IN ('VALIDACAO_EVIDENCIA','PROCESSAMENTO_ANTES_COMMIT','RECONCILIACAO_ANTES_COMMIT')),
        clock_id uuid NOT NULL,start_ms double precision NOT NULL CHECK(start_ms>=0 AND start_ms<'Infinity'::float8),
        end_ms double precision NOT NULL CHECK(end_ms>=start_ms AND end_ms<'Infinity'::float8),
        PRIMARY KEY(observation_id,revision,boundary),
        FOREIGN KEY(observation_id,revision) REFERENCES decision_revisions(observation_id,revision)
      );
      CREATE TRIGGER immutable_experiment_runs BEFORE UPDATE OR DELETE ON experiment_runs FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
      CREATE TRIGGER immutable_experiment_trials BEFORE UPDATE OR DELETE ON experiment_trials FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
      CREATE TRIGGER immutable_experiment_ground_truth BEFORE UPDATE OR DELETE ON experiment_ground_truth FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
      CREATE TRIGGER immutable_experiment_client_records BEFORE UPDATE OR DELETE ON experiment_client_records FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
      CREATE TRIGGER immutable_operation_measurements BEFORE UPDATE OR DELETE ON operation_measurements FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
    `);
  }
  async down(r: QueryRunner) {
    await r.query(
      'DROP TABLE operation_measurements, experiment_client_records, experiment_ground_truth, experiment_trials, experiment_runs;',
    );
  }
}
