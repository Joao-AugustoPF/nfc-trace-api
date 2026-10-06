import { DynamicModule, Module, OnApplicationShutdown } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CreateOrder } from '../bounded-contexts/traceability/application/create-order';
import { ProvisionTag } from '../bounded-contexts/traceability/application/provision-tag';
import {
  ActivateProvisioning,
  CloseProvisioning,
} from '../bounded-contexts/traceability/application/change-provisioning';
import { RecordObservation } from '../bounded-contexts/traceability/application/record-observation';
import { TraceabilityQueries } from '../bounded-contexts/traceability/application/queries';
import { TypeOrmUnitOfWork } from '../bounded-contexts/traceability/infrastructure/typeorm-unit-of-work';
import { TypeOrmTraceabilityReader } from '../bounded-contexts/traceability/infrastructure/typeorm-reader';
import {
  ObservationsController,
  OrdersController,
  ProvisioningsController,
  TagsController,
} from '../bounded-contexts/traceability/presentation/http/controllers';
import { AuditConsumer } from '../platform/audit/audit-consumer';
import { OutboxDispatcher } from '../platform/messaging/outbox-dispatcher';
import { OutboxWorker } from '../platform/messaging/outbox-worker';
import { HealthController } from '../platform/observability/health.controller';
import { NodeIds, Sha256Fingerprint, SystemClock } from '../platform/runtime';
import { AppConfig } from './config';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { PostgresIdentityStore } from '../bounded-contexts/identity/infrastructure/postgres-identity-store';
import { OpaqueTokens, ScryptPasswords } from '../bounded-contexts/identity/infrastructure/crypto';
import { SignIn } from '../bounded-contexts/identity/application/sign-in';
import { Authenticate } from '../bounded-contexts/identity/application/authenticate';
import { ManageAccounts } from '../bounded-contexts/identity/application/manage-accounts';
import {
  AuthenticationController,
  UsersController,
} from '../bounded-contexts/identity/presentation/http/controller';
import { AuthenticationGuard } from '../platform/access/http-security';

class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(
    private readonly source: DataSource,
    private readonly ownsSource: boolean,
  ) {}
  async onApplicationShutdown(): Promise<void> {
    if (this.ownsSource && this.source.isInitialized) await this.source.destroy();
  }
}

@Module({})
export class AppModule {
  static register(config: AppConfig, source: DataSource, ownsSource = true): DynamicModule {
    const uow = new TypeOrmUnitOfWork(source);
    const clock = new SystemClock();
    const ids = new NodeIds();
    const identity = new PostgresIdentityStore(source);
    const passwords = new ScryptPasswords();
    const tokens = new OpaqueTokens();
    const authenticate = new Authenticate(identity, tokens);
    const dispatcher = new OutboxDispatcher(source, [new AuditConsumer()], {
      batchSize: config.batchSize,
      leaseMs: config.leaseMs,
    });
    return {
      module: AppModule,
      controllers:
        config.role === 'events'
          ? []
          : [
              OrdersController,
              TagsController,
              ProvisioningsController,
              ObservationsController,
              HealthController,
              AuthenticationController,
              UsersController,
            ],
      providers: [
        {
          provide: SignIn,
          useFactory: () =>
            new SignIn(identity, passwords, tokens, clock, ids, config.sessionSeconds),
        },
        { provide: ManageAccounts, useFactory: () => new ManageAccounts(identity, passwords, ids) },
        {
          provide: APP_GUARD,
          useFactory: (reflector: Reflector) =>
            new AuthenticationGuard(reflector, authenticate, identity),
          inject: [Reflector],
        },
        { provide: DataSource, useValue: source },
        { provide: DatabaseLifecycle, useFactory: () => new DatabaseLifecycle(source, ownsSource) },
        { provide: CreateOrder, useFactory: () => new CreateOrder(uow, clock, ids) },
        { provide: ProvisionTag, useFactory: () => new ProvisionTag(uow, clock, ids) },
        {
          provide: ActivateProvisioning,
          useFactory: () => new ActivateProvisioning(uow, clock, ids),
        },
        { provide: CloseProvisioning, useFactory: () => new CloseProvisioning(uow, clock, ids) },
        {
          provide: RecordObservation,
          useFactory: () => new RecordObservation(uow, clock, ids, new Sha256Fingerprint()),
        },
        {
          provide: TraceabilityQueries,
          useFactory: () => new TraceabilityQueries(new TypeOrmTraceabilityReader(source)),
        },
        { provide: OutboxDispatcher, useValue: dispatcher },
        ...(config.role === 'api'
          ? []
          : [
              {
                provide: OutboxWorker,
                useFactory: () => new OutboxWorker(dispatcher, config.pollMs),
              },
            ]),
      ],
    };
  }
}
