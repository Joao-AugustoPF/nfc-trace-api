import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { traceabilityEntities } from '../../bounded-contexts/traceability/infrastructure/records';
import { InitialSchema1790000000000 } from './migrations/1790000000000-initial-schema';
import { Identity1790000001000 } from './migrations/1790000001000-identity';

export function createDataSource(url: string): DataSource {
  return new DataSource({
    type: 'postgres',
    url,
    entities: traceabilityEntities,
    migrations: [InitialSchema1790000000000, Identity1790000001000],
    synchronize: false,
    migrationsRun: false,
    logging: false,
    extra: { max: 15, connectionTimeoutMillis: 5000 },
  });
}
