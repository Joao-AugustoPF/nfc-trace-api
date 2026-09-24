import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createDataSource } from '../platform/database/data-source';
import { createHttpApplication } from './application';
import { AppModule } from './app.module';
import { readConfig } from './config';

async function main(): Promise<void> {
  loadEnv({ quiet: true });
  const config = readConfig();
  const source = await createDataSource(config.databaseUrl).initialize();
  try {
    if (config.role === 'events') {
      const app = await NestFactory.createApplicationContext(AppModule.register(config, source), {
        logger: new ConsoleLogger({ json: true }),
      });
      app.enableShutdownHooks();
    } else {
      const app = await createHttpApplication(config, source);
      await app.listen(config.port, config.host);
    }
  } catch (error) {
    if (source.isInitialized) await source.destroy();
    throw error;
  }
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
