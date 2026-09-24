import { config as loadEnv } from 'dotenv';
import { createDataSource } from '../database/data-source';
import { AuditConsumer } from '../audit/audit-consumer';
import { OutboxDispatcher } from './outbox-dispatcher';

async function main(): Promise<void> {
  loadEnv({ quiet: true });
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const source = await createDataSource(process.env.DATABASE_URL).initialize();
  try {
    const command = process.argv[2];
    if (command === 'list') {
      console.log(
        JSON.stringify(
          await source.query(`SELECT id, envelope->>'type' AS type, attempts,
        last_error, created_at FROM outbox WHERE status='FAILED' ORDER BY created_at LIMIT 100`),
          null,
          2,
        ),
      );
    } else if (command === 'retry' && /^[0-9a-f-]{36}$/i.test(process.argv[3] ?? '')) {
      const worker = new OutboxDispatcher(source, [new AuditConsumer()], {
        batchSize: 25,
        leaseMs: 30000,
      });
      if (!(await worker.retryFailed(process.argv[3]!)))
        throw new Error('Event not found in FAILED state');
      console.log('Evento recolocado na fila com a mesma identidade.');
    } else throw new Error('Usage: events CLI list | retry <event-uuid>');
  } finally {
    await source.destroy();
  }
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
