import { MigrationInterface, QueryRunner } from 'typeorm';

export class Identity1790000001000 implements MigrationInterface {
  name = 'Identity1790000001000';
  async up(runner: QueryRunner) {
    await runner.query(`
      CREATE TABLE identity_accounts (
        id uuid PRIMARY KEY, login varchar(64) NOT NULL UNIQUE,
        name varchar(100) NOT NULL, role varchar NOT NULL CHECK (role IN ('ADMINISTRADOR','OPERADOR','CONSULTA')),
        password_hash text NOT NULL, active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CHECK (login = lower(login))
      );
      CREATE TABLE identity_sessions (
        id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES identity_accounts(id),
        token_hash char(64) NOT NULL UNIQUE,
        expires_at timestamptz NOT NULL, revoked_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
      CREATE INDEX identity_user_sessions ON identity_sessions(user_id);
      CREATE TABLE identity_login_limits (
        key char(64) PRIMARY KEY, attempts integer NOT NULL, window_start timestamptz NOT NULL
      );
      CREATE TABLE security_audit (
        id uuid PRIMARY KEY, event_type varchar(100) NOT NULL,
        actor jsonb, subject_id uuid, outcome varchar NOT NULL,
        reason varchar(100), route varchar(200), correlation_id varchar(100) NOT NULL,
        occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
      CREATE INDEX security_audit_correlation ON security_audit(correlation_id);
      CREATE TRIGGER immutable_security_audit BEFORE UPDATE OR DELETE ON security_audit
        FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
      ALTER TABLE observations ADD COLUMN authenticated_actor jsonb;
      COMMENT ON COLUMN observations.authenticated_actor IS 'Trusted submitter at receipt; NULL for legacy or internal unauthenticated captures. Input operator/device remain declarations.';
    `);
  }
  async down(runner: QueryRunner) {
    await runner.query(
      'ALTER TABLE observations DROP COLUMN authenticated_actor; DROP TABLE security_audit, identity_login_limits, identity_sessions, identity_accounts;',
    );
  }
}
