import { EntityManager } from 'typeorm';
import { EventEnvelope } from '../../shared-kernel/events';

// Infrastructure-only contract: handlers may write database effects in the inbox transaction.
export interface ReliableConsumer {
  readonly id: string;
  handle(event: EventEnvelope, manager: EntityManager): Promise<void>;
}
