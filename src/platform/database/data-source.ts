import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { traceabilityEntities } from '../../bounded-contexts/traceability/infrastructure/records';
import { InitialSchema1790000000000 } from './migrations/1790000000000-initial-schema';
import { Identity1790000001000 } from './migrations/1790000001000-identity';
import { Sdm1790000002000 } from './migrations/1790000002000-sdm';
import { Reconciliation1790000003000 } from './migrations/1790000003000-reconciliation';
import { Experimentation1790000004000 } from './migrations/1790000004000-experimentation';
import { TagAdministration1790000005000 } from './migrations/1790000005000-tag-administration';
import { NfcPersonalization1790000006000 } from './migrations/1790000006000-nfc-personalization';

export function createDataSource(url: string): DataSource {
  return new DataSource({
    type: 'postgres',
    url,
    entities: traceabilityEntities,
    migrations: [
      InitialSchema1790000000000,
      Identity1790000001000,
      Sdm1790000002000,
      Reconciliation1790000003000,
      Experimentation1790000004000,
      TagAdministration1790000005000,
      NfcPersonalization1790000006000,
    ],
    synchronize: false,
    migrationsRun: false,
    logging: false,
    extra: { max: 15, connectionTimeoutMillis: 5000 },
  });
}
