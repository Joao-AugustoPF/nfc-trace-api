import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { CreateOrder } from '../src/bounded-contexts/traceability/application/create-order';
import { ProvisionTag } from '../src/bounded-contexts/traceability/application/provision-tag';
import { ActivateProvisioning } from '../src/bounded-contexts/traceability/application/change-provisioning';
import { RecordObservation } from '../src/bounded-contexts/traceability/application/record-observation';
import { UnitOfWork } from '../src/bounded-contexts/traceability/application/ports';
import { TypeOrmUnitOfWork } from '../src/bounded-contexts/traceability/infrastructure/typeorm-unit-of-work';
import { AuditConsumer } from '../src/platform/audit/audit-consumer';
import { OutboxDispatcher } from '../src/platform/messaging/outbox-dispatcher';
import { NodeIds, Sha256Fingerprint, SystemClock } from '../src/platform/runtime';
import { resetDatabase, testDatabase } from './support';

describe('Transactional state and reliable event delivery', () => {
  let source: DataSource;
  const ids = new NodeIds();
  const clock = new SystemClock();
  const dispatcher = (batchSize = 25) =>
    new OutboxDispatcher(source, [new AuditConsumer()], { batchSize, leaseMs: 30000 });
  const create = () =>
    new CreateOrder(new TypeOrmUnitOfWork(source), clock, ids).execute(
      { codigo: `LAB-${randomUUID()}` },
      'reliability-test',
    );
  beforeAll(async () => {
    source = await testDatabase();
  });
  afterAll(async () => {
    if (source?.isInitialized) await source.destroy();
  });
  beforeEach(async () => {
    await resetDatabase(source);
  });

  it('commits audit, inbox and delivery together and deduplicates redelivery', async () => {
    await create();
    await dispatcher().tick();
    expect(await source.query('SELECT * FROM audit_log')).toHaveLength(1);
    expect(await source.query('SELECT * FROM inbox')).toHaveLength(1);
    await source.query("UPDATE outbox SET status='PENDING', attempts=0");
    await dispatcher().tick();
    expect(await source.query('SELECT * FROM audit_log')).toHaveLength(1);
    expect(await source.query('SELECT * FROM inbox')).toHaveLength(1);
    expect(await source.query("SELECT * FROM outbox WHERE status='PROCESSED'")).toHaveLength(1);
  });
  it('rolls back a partially completed consumer transaction before retry', async () => {
    await create();
    const broken = new OutboxDispatcher(
      source,
      [
        new AuditConsumer(),
        {
          id: 'failing.v1',
          async handle() {
            throw new Error('simulated interruption before acknowledgement');
          },
        },
      ],
      { batchSize: 25, leaseMs: 30000 },
    );
    await broken.tick();
    expect(await source.query('SELECT * FROM audit_log')).toHaveLength(0);
    expect(await source.query('SELECT * FROM inbox')).toHaveLength(0);
    expect((await source.query('SELECT status, attempts FROM outbox'))[0]).toEqual({
      status: 'PENDING',
      attempts: 1,
    });
    await source.query("UPDATE outbox SET available_at=clock_timestamp() - interval '1 second'");
    await dispatcher().tick();
    expect(await source.query('SELECT * FROM audit_log')).toHaveLength(1);
  });
  it('recovers a claimed event after reconnection and fences the stale worker', async () => {
    await create();
    const previous = (await dispatcher().claim())[0]!;
    await source.query("UPDATE outbox SET locked_until=clock_timestamp() - interval '1 second'");
    await source.destroy();
    source = await testDatabase();
    const replacement = (await dispatcher().claim())[0]!;
    expect(replacement.id).toBe(previous.id);
    expect(replacement.lock_token).not.toBe(previous.lock_token);
    await dispatcher().deliver(previous);
    expect(await source.query('SELECT * FROM audit_log')).toHaveLength(0);
    await dispatcher().deliver(replacement);
    expect(await source.query('SELECT * FROM audit_log')).toHaveLength(1);
  });
  it('exhausts five attempts and explicitly requeues the same event identity', async () => {
    await create();
    const broken = new OutboxDispatcher(
      source,
      [
        {
          id: 'audit.v1',
          async handle() {
            throw new Error('poison');
          },
        },
      ],
      { batchSize: 25, leaseMs: 30000 },
    );
    for (let i = 0; i < 5; i++) {
      await broken.tick();
      await source.query("UPDATE outbox SET available_at=clock_timestamp() - interval '1 second'");
    }
    const failed = (await source.query('SELECT id, status, attempts FROM outbox'))[0] as {
      id: string;
      status: string;
      attempts: number;
    };
    expect(failed).toMatchObject({ status: 'FAILED', attempts: 5 });
    expect(await broken.claim()).toHaveLength(0);
    expect(await dispatcher().retryFailed(failed.id)).toBe(true);
    await dispatcher().tick();
    expect((await source.query('SELECT event_id FROM audit_log'))[0]).toEqual({
      event_id: failed.id,
    });
    expect(await dispatcher().retryFailed(failed.id)).toBe(false);
  });
  it('marks a lease lost on the fifth attempt as failed', async () => {
    await create();
    await source.query('UPDATE outbox SET attempts=4');
    await dispatcher().claim();
    await source.query("UPDATE outbox SET locked_until=clock_timestamp() - interval '1 second'");
    expect(await dispatcher().claim()).toHaveLength(0);
    expect((await source.query('SELECT status FROM outbox'))[0].status).toBe('FAILED');
  });
  it('shares work safely between concurrent dispatchers', async () => {
    for (let i = 0; i < 12; i++) await create();
    const a = dispatcher(6);
    const b = dispatcher(6);
    await Promise.all([a.tick(), b.tick()]);
    expect(await source.query('SELECT * FROM audit_log')).toHaveLength(12);
    expect(await source.query('SELECT * FROM inbox')).toHaveLength(12);
    expect(await source.query("SELECT * FROM outbox WHERE status <> 'PROCESSED'")).toHaveLength(0);
  });
  it('rolls back order, observation, decision and movement if outbox persistence fails', async () => {
    const uow = new TypeOrmUnitOfWork(source);
    const order = await create();
    const tag = await new ProvisionTag(uow, clock, ids).execute(
      { pedidoId: order.id, uid: '04AABBCCDDEE01', modelo: 'NTAG424DNA', estrategia: 'UID' },
      'test',
    );
    await new ActivateProvisioning(uow, clock, ids).execute(
      tag.id,
      { bloqueioConfirmado: true },
      'test',
    );
    const before = await source.query('SELECT id FROM outbox');
    const faulty: UnitOfWork = {
      run: (work) =>
        uow.run((tx) =>
          work({
            ...tx,
            outbox: {
              async append() {
                throw new Error('simulated outbox write failure');
              },
            },
          }),
        ),
    };
    const record = new RecordObservation(faulty, clock, ids, new Sha256Fingerprint());
    await expect(
      record.execute(
        {
          id: randomUUID(),
          versaoContrato: 1,
          provisionamentoId: tag.id,
          tipo: 'COLETA',
          ocorridoEm: clock.now(),
          dispositivoId: 'lab',
          leituraBruta: { uid: tag.uid },
        },
        'test',
      ),
    ).rejects.toThrow('outbox write failure');
    expect((await source.query('SELECT state FROM orders'))[0].state).toBe('CADASTRADO');
    expect(await source.query('SELECT * FROM observations')).toHaveLength(0);
    expect(await source.query('SELECT * FROM decisions')).toHaveLength(0);
    expect(await source.query("SELECT * FROM movements WHERE type='COLETA'")).toHaveLength(0);
    expect(await source.query('SELECT id FROM outbox')).toEqual(before);
  });
});
