import 'reflect-metadata';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDataSource } from '../src/platform/database/data-source';
import { createHttpApplication } from '../src/bootstrap/application';
import { createOpenApiDocument } from '../src/bootstrap/openapi';
import { readConfig } from '../src/bootstrap/config';

async function main(): Promise<void> {
  const config = readConfig({
    DATABASE_URL: 'postgresql://unused:unused@localhost:5432/unused',
    APP_PROCESS_ROLE: 'api',
  });
  // API-only composition permits schema export without a database connection.
  const app = await createHttpApplication(
    config,
    createDataSource(config.databaseUrl),
    false,
    true,
  );
  try {
    const directory = resolve('docs');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      resolve(directory, 'openapi.json'),
      JSON.stringify(createOpenApiDocument(app), null, 2) + '\n',
    );
  } finally {
    await app.close();
  }
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
