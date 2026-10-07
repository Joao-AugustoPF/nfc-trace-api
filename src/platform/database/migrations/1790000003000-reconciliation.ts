import { MigrationInterface, QueryRunner } from 'typeorm';

export class Reconciliation1790000003000 implements MigrationInterface {
  name = 'Reconciliation1790000003000';
  async up(runner: QueryRunner) {
    await runner.query(`
      CREATE TABLE decision_revisions (
        observation_id uuid NOT NULL REFERENCES observations(id),
        revision integer NOT NULL CHECK (revision > 0), result jsonb NOT NULL,
        evaluated_at timestamptz NOT NULL, cause_id uuid,
        PRIMARY KEY(observation_id, revision),
        CHECK (result ?& ARRAY['revision','status','evaluatedAt','accepted']),
        CHECK ((result->>'revision')::integer = revision),
        CHECK (result->>'status' IS NOT NULL AND result->>'status' IN ('AUTORIZADA','PENDENTE','REJEITADA','TARDIA')),
        CHECK ((result->>'accepted')::boolean = (result->>'status'='AUTORIZADA'))
      );
      CREATE TRIGGER immutable_decision_revisions BEFORE UPDATE OR DELETE ON decision_revisions
        FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
      CREATE TABLE current_decisions (
        observation_id uuid PRIMARY KEY, revision integer NOT NULL,
        status varchar NOT NULL CHECK (status IN ('AUTORIZADA','PENDENTE','REJEITADA','TARDIA')),
        FOREIGN KEY(observation_id,revision) REFERENCES decision_revisions(observation_id,revision)
      );
      CREATE INDEX pending_decisions ON current_decisions(observation_id) WHERE status='PENDENTE';
      INSERT INTO decision_revisions
        SELECT d.observation_id,1,d.result || jsonb_build_object(
          'revision',1,'status',CASE WHEN (d.result->>'accepted')::boolean THEN 'AUTORIZADA'
            WHEN d.result->'sdm'->>'temporalidade'='TARDIA' THEN 'TARDIA' ELSE 'REJEITADA' END,
          'evaluatedAt',to_char(o.received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'dependencies','[]'::jsonb,'expiresAt',NULL,'causeId',NULL),o.received_at,NULL
        FROM decisions d JOIN observations o ON o.id=d.observation_id;
      INSERT INTO current_decisions SELECT observation_id,revision,result->>'status' FROM decision_revisions;
      CREATE FUNCTION preserve_decision_projection() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND (NEW.observation_id IS DISTINCT FROM OLD.observation_id
          OR OLD.status <> 'PENDENTE' OR NEW.revision <> OLD.revision + 1)) THEN
          RAISE EXCEPTION 'Decision projection must advance a pending revision' USING ERRCODE='23514';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM decision_revisions r WHERE r.observation_id=NEW.observation_id
          AND r.revision=NEW.revision AND r.result->>'status'=NEW.status) THEN
          RAISE EXCEPTION 'Decision projection must match its revision' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER monotonic_decision_projection BEFORE INSERT OR UPDATE OR DELETE ON current_decisions
        FOR EACH ROW EXECUTE FUNCTION preserve_decision_projection();
    `);
  }
  async down(runner: QueryRunner) {
    await runner.query(
      'DROP TABLE current_decisions, decision_revisions; DROP FUNCTION preserve_decision_projection();',
    );
  }
}
