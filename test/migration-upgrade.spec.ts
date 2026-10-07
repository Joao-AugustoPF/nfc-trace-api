import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { createDataSource } from '../src/platform/database/data-source';
import { InitialSchema1790000000000 } from '../src/platform/database/migrations/1790000000000-initial-schema';
import { testDatabase } from './support';

describe('Populated v1 migration to current schema', () => {
  let admin: DataSource;
  let source: DataSource;
  const schema = `upgrade_${randomUUID().replaceAll('-', '')}`;
  beforeAll(async () => {
    admin = await testDatabase();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    source = createDataSource(String(admin.options.type === 'postgres' && admin.options.url));
    source.setOptions({
      schema,
      migrations: [InitialSchema1790000000000],
      extra: { options: `-c search_path=${schema}` },
    });
    await source.initialize();
    await source.runMigrations({ transaction: 'all' });
  });
  afterAll(async () => {
    if (source?.isInitialized) await source.destroy();
    // This exact generated schema is the only cleanup target; never public/lab data.
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.destroy();
    }
  });
  it('preserves original input, receipts, effects, epochs and outbox while backfilling revisions', async () => {
    const [order, tag, provisioning, observation, movement, event] = Array.from(
      { length: 6 },
      randomUUID,
    );
    const now = '2026-09-24T12:00:00.000Z';
    const input = {
      id: observation,
      tipo: 'COLETA',
      provisionamentoId: provisioning,
      dispositivoId: 'generated-migration-fixture',
      versaoContrato: 1,
      ocorridoEm: now,
      leituraBruta: { uid: '04AABBCCDDEE01' },
    };
    const receipt = {
      accepted: true,
      reason: 'ACEITA',
      evidence: 'IDENTIFICADA',
      stateChanged: true,
      previousState: 'CADASTRADO',
      resultingState: 'COLETADO',
      classification: 'REGULAR',
      warnings: [],
    };
    await source.query('INSERT INTO orders VALUES ($1,$2,NULL,$3,false,1,$4)', [
      order,
      'LEGACY-FIXTURE',
      'COLETADO',
      now,
    ]);
    await source.query('INSERT INTO tags VALUES ($1,$2,$3,$4)', [
      tag,
      '04AABBCCDDEE01',
      'SYNTHETIC-MIGRATION',
      now,
    ]);
    await source.query('INSERT INTO provisionings VALUES ($1,$2,$3,$4,1,$5,$6,$6,NULL)', [
      provisioning,
      tag,
      order,
      'UID',
      'ATIVA',
      now,
    ]);
    await source.query('INSERT INTO observations VALUES ($1,$2,$3,$4,$5,$6,$7)', [
      observation,
      order,
      provisioning,
      'UID',
      'f'.repeat(64),
      input,
      now,
    ]);
    await source.query('INSERT INTO decisions VALUES ($1,$2)', [observation, receipt]);
    await source.query('INSERT INTO movements VALUES ($1,$2,$3,$4,$5,$6,$6)', [
      movement,
      order,
      provisioning,
      observation,
      'COLETA',
      now,
    ]);
    await source.query('INSERT INTO outbox(id,envelope,created_at) VALUES ($1,$2,$3)', [
      event,
      { id: event, type: 'LegacyFixture' },
      now,
    ]);
    const before = await source.query('SELECT input,fingerprint,received_at FROM observations');
    await source.destroy();
    source = createDataSource(String(admin.options.type === 'postgres' && admin.options.url));
    source.setOptions({ schema, extra: { options: `-c search_path=${schema}` } });
    await source.initialize();
    await source.runMigrations({ transaction: 'all' });
    expect(await source.query('SELECT input,fingerprint,received_at FROM observations')).toEqual(
      before,
    );
    expect((await source.query('SELECT result FROM decisions'))[0].result).toEqual(receipt);
    expect(await source.query('SELECT id,observation_id FROM movements')).toEqual([
      { id: movement, observation_id: observation },
    ]);
    expect(await source.query('SELECT epoch,status FROM provisionings')).toEqual([
      { epoch: 1, status: 'ATIVA' },
    ]);
    expect(await source.query('SELECT id,status,attempts FROM outbox')).toEqual([
      { id: event, status: 'PENDING', attempts: 0 },
    ]);
    expect(await source.query('SELECT revision,status FROM current_decisions')).toEqual([
      { revision: 1, status: 'AUTORIZADA' },
    ]);
    expect((await source.query('SELECT result FROM decision_revisions'))[0].result).toMatchObject({
      ...receipt,
      revision: 1,
      status: 'AUTORIZADA',
      evaluatedAt: now,
    });
    expect((await source.query('SELECT count(*)::int AS n FROM migrations'))[0].n).toBe(5);
    await expect(
      source.query('UPDATE observations SET fingerprint=$1', ['0'.repeat(64)]),
    ).rejects.toThrow('append-only');
    expect((await source.query('SELECT count(*)::int AS n FROM experiment_runs'))[0].n).toBe(0);
  });
});
