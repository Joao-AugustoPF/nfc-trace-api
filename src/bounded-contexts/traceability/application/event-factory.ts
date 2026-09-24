import { DomainEvent, EventEnvelope } from '../../../shared-kernel/events';
import { IdGenerator } from './ports';

export function envelopes(
  events: DomainEvent[],
  ids: IdGenerator,
  now: string,
  correlationId: string,
  causationId: string | null,
): EventEnvelope[] {
  return events.map((event) => ({
    ...event,
    id: ids.next(),
    version: 1,
    occurredAt: now,
    correlationId,
    causationId,
  }));
}
