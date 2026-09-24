import { DomainEvent, EventEnvelope } from '../../../shared-kernel/events';
import { IdGenerator } from './ports';
import { AuthenticatedActor } from '../../../shared-kernel/actor';

export function envelopes(
  events: DomainEvent[],
  ids: IdGenerator,
  now: string,
  correlationId: string,
  causationId: string | null,
  actor: AuthenticatedActor | null = null,
): EventEnvelope[] {
  return events.map((event) => ({
    ...event,
    payload: { ...event.payload, atorAutenticado: actor },
    id: ids.next(),
    version: 1,
    occurredAt: now,
    correlationId,
    causationId,
  }));
}
