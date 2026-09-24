import { EntityManager } from 'typeorm';
import { EventEnvelope } from '../../shared-kernel/events';
import { ReliableConsumer } from '../messaging/consumer';

export class AuditConsumer implements ReliableConsumer {
  readonly id = 'audit.v1';
  async handle(event: EventEnvelope, manager: EntityManager): Promise<void> {
    await manager.query(
      `INSERT INTO audit_log
      (event_id, event_type, aggregate_id, correlation_id, causation_id, occurred_at, payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        event.id,
        event.type,
        event.aggregateId,
        event.correlationId,
        event.causationId,
        event.occurredAt,
        event.payload,
      ],
    );
  }
}
