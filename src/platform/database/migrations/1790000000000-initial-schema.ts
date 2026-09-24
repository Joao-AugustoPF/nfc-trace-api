import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1790000000000 implements MigrationInterface {
  name = 'InitialSchema1790000000000';
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE orders (
        id uuid PRIMARY KEY, code varchar(64) NOT NULL UNIQUE, description text,
        state varchar NOT NULL CHECK (state IN ('CADASTRADO','COLETADO','RECEBIDO','ENTREGUE')),
        dispatched boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
        created_at timestamptz NOT NULL
      );
      CREATE TABLE tags (
        id uuid PRIMARY KEY, uid varchar(20) NOT NULL UNIQUE CHECK (uid ~ '^([0-9A-F]{2}){4,10}$'),
        model varchar(64) NOT NULL, created_at timestamptz NOT NULL
      );
      CREATE TABLE provisionings (
        id uuid PRIMARY KEY, tag_id uuid NOT NULL REFERENCES tags(id), order_id uuid NOT NULL REFERENCES orders(id),
        strategy varchar NOT NULL CHECK (strategy IN ('UID','NDEF_ESTATICO')),
        epoch integer NOT NULL CHECK (epoch > 0),
        status varchar NOT NULL CHECK (status IN ('REGISTRADA','ATIVA','DESPROVISIONADA')),
        created_at timestamptz NOT NULL, activated_at timestamptz, closed_at timestamptz,
        UNIQUE(tag_id, epoch),
        CHECK (status <> 'ATIVA' OR activated_at IS NOT NULL),
        CHECK ((status = 'DESPROVISIONADA') = (closed_at IS NOT NULL))
      );
      CREATE UNIQUE INDEX live_order_binding ON provisionings(order_id) WHERE status <> 'DESPROVISIONADA';
      CREATE UNIQUE INDEX live_tag_binding ON provisionings(tag_id) WHERE status <> 'DESPROVISIONADA';
      CREATE TABLE observations (
        id uuid PRIMARY KEY, order_id uuid REFERENCES orders(id),
        provisioning_id uuid NOT NULL,
        strategy varchar CHECK (strategy IN ('UID','NDEF_ESTATICO')),
        fingerprint varchar(64) NOT NULL, input jsonb NOT NULL, received_at timestamptz NOT NULL
      );
      COMMENT ON COLUMN observations.provisioning_id IS 'Client claim; deliberately no FK, preserving unknown binding attempts';
      CREATE INDEX observations_history ON observations(order_id, received_at, id);
      CREATE TABLE decisions (
        observation_id uuid PRIMARY KEY REFERENCES observations(id), result jsonb NOT NULL
      );
      CREATE TABLE movements (
        id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES orders(id),
        provisioning_id uuid NOT NULL REFERENCES provisionings(id), observation_id uuid UNIQUE REFERENCES observations(id),
        type varchar NOT NULL CHECK (type IN ('PROVISIONAMENTO','COLETA','RECEBIMENTO','MOVIMENTACAO','EXPEDICAO','ENTREGA')),
        occurred_at timestamptz NOT NULL, received_at timestamptz NOT NULL,
        CHECK ((type = 'PROVISIONAMENTO') = (observation_id IS NULL))
      );
      CREATE UNIQUE INDEX provisioning_movement ON movements(provisioning_id) WHERE type = 'PROVISIONAMENTO';
      CREATE INDEX movements_history ON movements(order_id, received_at, id);
      CREATE TABLE outbox (
        id uuid PRIMARY KEY, envelope jsonb NOT NULL,
        status varchar NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PROCESSING','PROCESSED','FAILED')),
        attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
        available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        locked_until timestamptz, lock_token uuid, last_error text,
        created_at timestamptz NOT NULL, processed_at timestamptz
      );
      CREATE INDEX outbox_dispatch ON outbox(status, available_at, created_at);
      CREATE TABLE inbox (
        consumer_id varchar(100) NOT NULL, event_id uuid NOT NULL REFERENCES outbox(id),
        processed_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(consumer_id, event_id)
      );
      CREATE TABLE audit_log (
        event_id uuid PRIMARY KEY REFERENCES outbox(id), event_type varchar(100) NOT NULL,
        aggregate_id uuid NOT NULL, correlation_id varchar(100) NOT NULL,
        causation_id uuid, occurred_at timestamptz NOT NULL,
        recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), payload jsonb NOT NULL
      );
      CREATE INDEX audit_correlation ON audit_log(correlation_id);
      CREATE FUNCTION reject_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Historical records are append-only' USING ERRCODE = '23514'; END; $$;
      CREATE TRIGGER immutable_observations BEFORE UPDATE OR DELETE ON observations FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
      CREATE TRIGGER immutable_decisions BEFORE UPDATE OR DELETE ON decisions FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
      CREATE TRIGGER immutable_movements BEFORE UPDATE OR DELETE ON movements FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
      CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
      CREATE FUNCTION preserve_provisioning_identity() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (NEW.id, NEW.tag_id, NEW.order_id, NEW.epoch, NEW.strategy) IS DISTINCT FROM
           (OLD.id, OLD.tag_id, OLD.order_id, OLD.epoch, OLD.strategy) THEN
          RAISE EXCEPTION 'Provisioning identity is immutable' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER immutable_provisioning_identity BEFORE UPDATE ON provisionings
        FOR EACH ROW EXECUTE FUNCTION preserve_provisioning_identity();
    `);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE audit_log, inbox, outbox, movements, decisions, observations, provisionings, tags, orders;
      DROP FUNCTION preserve_provisioning_identity();
      DROP FUNCTION reject_history_mutation();
    `);
  }
}
