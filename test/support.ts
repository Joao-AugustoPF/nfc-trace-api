import { DataSource } from 'typeorm';
import { createDataSource } from '../src/platform/database/data-source';

export async function testDatabase(): Promise<DataSource> {
  const url =
    process.env.TEST_DATABASE_URL ??
    'postgresql://nfc_trace:nfc_trace_local@localhost:55432/nfc_trace_test';
  if (!new URL(url).pathname.endsWith('_test'))
    throw new Error('Integration database name MUST end in _test');
  const source = await createDataSource(url).initialize();
  await source.runMigrations({ transaction: 'all' });
  return source;
}

export async function resetDatabase(source: DataSource): Promise<void> {
  await source.query(
    'TRUNCATE audit_log, inbox, outbox, movements, decisions, observations, provisionings, tags, orders',
  );
}
