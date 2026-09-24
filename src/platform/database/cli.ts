import { config as loadEnv } from 'dotenv';
import { createDataSource } from './data-source';
import { TypeOrmUnitOfWork } from '../../bounded-contexts/traceability/infrastructure/typeorm-unit-of-work';
import { CreateOrder } from '../../bounded-contexts/traceability/application/create-order';
import { NodeIds, SystemClock } from '../runtime';

async function main(): Promise<void> {
  loadEnv({ quiet: true });
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const source = await createDataSource(process.env.DATABASE_URL).initialize();
  try {
    const command = process.argv[2];
    if (command === 'migrate') {
      const migrations = await source.runMigrations({ transaction: 'all' });
      console.log(JSON.stringify({ migrations: migrations.map((m) => m.name) }));
    } else if (command === 'seed') {
      const useCase = new CreateOrder(
        new TypeOrmUnitOfWork(source),
        new SystemClock(),
        new NodeIds(),
      );
      for (const code of ['TCC-001', 'TCC-002', 'TCC-003']) {
        const rows: { id: string }[] = await source.query('SELECT id FROM orders WHERE code = $1', [
          code,
        ]);
        if (!rows.length)
          await useCase.execute(
            { codigo: code, descricao: 'Pedido de demonstração do laboratório' },
            'seed',
          );
      }
      console.log('Pedidos de demonstração disponíveis. Nenhuma etiqueta física foi provisionada.');
    } else throw new Error('Usage: db CLI migrate | seed');
  } finally {
    await source.destroy();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
