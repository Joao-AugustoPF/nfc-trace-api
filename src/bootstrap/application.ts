import 'reflect-metadata';
import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppConfig } from './config';
import { AppModule } from './app.module';
import { configureHttp } from './http';
import { configureOpenApi } from './openapi';

export async function createHttpApplication(
  config: AppConfig,
  source: DataSource,
  ownsSource = true,
  silent = false,
) {
  const app = await NestFactory.create(AppModule.register(config, source, ownsSource), {
    bodyParser: false,
    logger: silent ? false : new ConsoleLogger({ json: true }),
  });
  configureHttp(app);
  configureOpenApi(app);
  app.enableShutdownHooks();
  await app.init();
  return app;
}
