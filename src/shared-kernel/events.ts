export interface DomainEvent {
  readonly type: string;
  readonly aggregateId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface EventEnvelope extends DomainEvent {
  readonly id: string;
  readonly version: 1;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

export abstract class AggregateRoot {
  private events: DomainEvent[] = [];

  protected raise(event: DomainEvent): void {
    this.events.push(event);
  }

  pullEvents(): DomainEvent[] {
    const events = this.events;
    this.events = [];
    return events;
  }
}
