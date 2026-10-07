import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { AuthenticatedActor } from '../../../shared-kernel/actor';
import { DomainError } from '../../../shared-kernel/domain-error';
import { ExperimentStore, ExperimentTransaction } from '../application/ports';
import {
  ClientRecordInput,
  Dataset,
  GroundTruthInput,
  RunInput,
  Stored,
  TrialInput,
} from '../domain/types';

type Row<T> = {
  input: T;
  fingerprint: string;
  user_id: string;
  recorded_at: Date;
  revision?: number;
};
const stored = <T>(r: Row<T>): Stored<T> => ({
  input: r.input,
  userId: r.user_id,
  recordedAt: r.recorded_at.toISOString(),
});
const columns = 'input,fingerprint,user_id,recorded_at';
type Authorize = (m: EntityManager, actor: AuthenticatedActor, admin: boolean) => Promise<void>;
function transaction(m: EntityManager, authorize: Authorize): ExperimentTransaction {
  const get = async <T>(table: string, id: string) => {
    const rows: Row<T>[] = await m.query(
      `SELECT ${columns}${table === 'experiment_ground_truth' ? ',revision' : ''} FROM ${table} WHERE id=$1`,
      [id],
    );
    return rows[0];
  };
  const insert = async <T>(
    table: string,
    input: T & { id: string },
    fingerprint: string,
    actor: AuthenticatedActor,
    extraColumns: string = '',
    extraValues: unknown[] = [],
  ) => {
    const extras = extraValues.map((_, i) => '$' + (i + 5)).join(',');
    const rows: Row<T>[] = await m.query(
      `INSERT INTO ${table}(id,input,fingerprint,user_id${extraColumns}) VALUES($1,$2,$3,$4${extras ? ',' + extras : ''}) RETURNING ${columns}${table === 'experiment_ground_truth' ? ',revision' : ''}`,
      [input.id, input, fingerprint, actor.userId, ...extraValues],
    );
    return rows[0]!;
  };
  return {
    authorize: (actor, admin) => authorize(m, actor, admin),
    async lock(id) {
      await m.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['experiment:' + id]);
    },
    async run(id) {
      const r = await get<RunInput>('experiment_runs', id);
      return r ? stored(r) : null;
    },
    async trial(id) {
      const r = await get<TrialInput>('experiment_trials', id);
      return r ? stored(r) : null;
    },
    async client(id) {
      const r = await get<ClientRecordInput>('experiment_client_records', id);
      return r ? { ...stored(r), fingerprint: r.fingerprint } : null;
    },
    async truth(id) {
      const r = await get<GroundTruthInput>('experiment_ground_truth', id);
      return r ? { ...stored(r), fingerprint: r.fingerprint, revision: r.revision! } : null;
    },
    async provisioning(id) {
      const rows: { strategy: string; policy: string | null }[] = await m.query(
        "SELECT strategy,sdm->>'policy' AS policy FROM provisionings WHERE id=$1",
        [id],
      );
      return rows[0] ?? null;
    },
    async insertRun(i, f, a) {
      return stored(await insert('experiment_runs', i, f, a));
    },
    async insertTrial(i, f, a) {
      return stored(
        await insert('experiment_trials', i, f, a, ',run_id,session_id,provisioning_id,ordinal', [
          i.runId,
          i.sessionId,
          i.provisioningId,
          i.ordinal,
        ]),
      );
    },
    async insertTruth(i, f, a) {
      const rev = (
        await m.query(
          'SELECT COALESCE(MAX(revision),0)+1 AS revision FROM experiment_ground_truth WHERE trial_id=$1',
          [i.trialId],
        )
      )[0].revision as number;
      const r = await insert('experiment_ground_truth', i, f, a, ',trial_id,revision', [
        i.trialId,
        rev,
      ]);
      return { ...stored(r), revision: rev };
    },
    async insertClient(i, f, a) {
      return stored(
        await insert('experiment_client_records', i, f, a, ',trial_id,attempt_id,observation_id', [
          i.trialId,
          i.attemptId,
          i.observationId,
        ]),
      );
    },
  };
}
export class PostgresExperimentStore implements ExperimentStore {
  constructor(
    private readonly source: DataSource,
    private readonly authorize: Authorize,
  ) {}
  async write<T>(work: (tx: ExperimentTransaction) => Promise<T>) {
    try {
      return await this.source.transaction((m) => work(transaction(m, this.authorize)));
    } catch (e) {
      if (e instanceof QueryFailedError && (e.driverError as { code?: string }).code === '23505')
        throw new DomainError(
          'EXPERIMENTO_CONFLITANTE',
          'Identificador ou ordem já utilizados.',
          'conflict',
        );
      throw e;
    }
  }
  async runs(page: number, limit: number) {
    const rows: Row<RunInput>[] = await this.source.query(
      `SELECT ${columns} FROM experiment_runs ORDER BY recorded_at DESC,id LIMIT $1 OFFSET $2`,
      [limit, (page - 1) * limit],
    );
    return {
      items: rows.map(stored),
      total: Number((await this.source.query('SELECT COUNT(*) FROM experiment_runs'))[0].count),
    };
  }
  async trials(id: string, page: number, limit: number) {
    const rows: Row<TrialInput>[] = await this.source.query(
      `SELECT ${columns} FROM experiment_trials WHERE run_id=$1 ORDER BY session_id,ordinal,id LIMIT $2 OFFSET $3`,
      [id, limit, (page - 1) * limit],
    );
    return {
      items: rows.map(stored),
      total: Number(
        (await this.source.query('SELECT COUNT(*) FROM experiment_trials WHERE run_id=$1', [id]))[0]
          .count,
      ),
    };
  }
  async export(id: string): Promise<Dataset | null> {
    const runner = this.source.createQueryRunner();
    await runner.connect();
    await runner.startTransaction('REPEATABLE READ');
    try {
      await runner.query('SET TRANSACTION READ ONLY');
      const runs: Row<RunInput>[] = await runner.query(
        `SELECT ${columns} FROM experiment_runs WHERE id=$1`,
        [id],
      );
      if (!runs[0]) return null;
      const trials: Row<TrialInput>[] = await runner.query(
        `SELECT ${columns} FROM experiment_trials WHERE run_id=$1 ORDER BY session_id,ordinal,id`,
        [id],
      );
      const truth: (Row<GroundTruthInput> & { revision: number })[] = await runner.query(
        `SELECT g.${columns.replaceAll(',', ',g.')},g.revision FROM experiment_ground_truth g JOIN experiment_trials t ON t.id=g.trial_id WHERE t.run_id=$1 ORDER BY g.trial_id,g.revision`,
        [id],
      );
      const records: Row<ClientRecordInput>[] = await runner.query(
        `SELECT c.${columns.replaceAll(',', ',c.')} FROM experiment_client_records c JOIN experiment_trials t ON t.id=c.trial_id WHERE t.run_id=$1 ORDER BY c.recorded_at,c.id`,
        [id],
      );
      const ids = [
        ...new Set(records.flatMap((r) => (r.input.observationId ? [r.input.observationId] : []))),
      ];
      // Whitelist projection: no credentials, identity sessions, sealed keys or arbitrary rows.
      const observations = await runner.query(
        `SELECT o.id,o.input,o.provisioning_id AS "provisioningId",o.strategy,o.received_at AS "receivedAt",o.input->>'ocorridoEm' AS "declaredAt",o.input->>'dispositivoId' AS "deviceId",o.authenticated_actor->>'userId' AS "userId",o.input->>'tipo' AS "eventType",o.input->'leituraBruta'->>'uid' AS uid,o.input->'leituraBruta'->>'ndef' AS ndef,o.input->'leituraBruta'->>'bytesBase64' AS "bytesBase64",d.result AS receipt,
        (SELECT jsonb_agg(jsonb_build_object('revision',r.revision,'result',r.result) ORDER BY r.revision) FROM decision_revisions r WHERE r.observation_id=o.id) AS decisions,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id',m.id,'type',m.type) ORDER BY m.id) FROM movements m WHERE m.observation_id=o.id),'[]'::jsonb) AS movements
        FROM observations o JOIN decisions d ON d.observation_id=o.id WHERE o.id=ANY($1::uuid[]) ORDER BY o.received_at,o.id`,
        [ids],
      );
      const measurements = await runner.query(
        `SELECT observation_id AS "observationId",revision,boundary,clock_id AS "clockId",start_ms AS "startMs",end_ms AS "endMs" FROM operation_measurements WHERE observation_id=ANY($1::uuid[]) ORDER BY observation_id,revision,boundary`,
        [ids],
      );
      return {
        schemaVersion: 1,
        run: stored(runs[0]),
        trials: trials.map(stored),
        groundTruth: truth.map((r) => ({ ...stored(r), revision: r.revision })),
        clientRecords: records.map(stored),
        observations: observations.map((o: Dataset['observations'][number]) => ({
          ...o,
          receivedAt: new Date(o.receivedAt).toISOString(),
        })),
        serverMeasurements: measurements,
      };
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  }
}
