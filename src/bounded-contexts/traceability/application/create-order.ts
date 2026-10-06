import { Order } from '../domain/order';
import { AuthenticatedActor } from '../../../shared-kernel/actor';
import { Clock, IdGenerator, UnitOfWork } from './ports';
import { envelopes } from './event-factory';
import { orderView } from './views';

export class CreateOrder {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(
    input: { codigo: string; descricao?: string },
    correlationId: string,
    actor: AuthenticatedActor | null = null,
  ) {
    return this.uow.run(async (tx) => {
      const now = this.clock.now();
      const order = Order.create(this.ids.next(), input.codigo, input.descricao, now);
      await tx.orders.save(order);
      await tx.outbox.append(
        envelopes(order.pullEvents(), this.ids, now, correlationId, null, actor),
      );
      return orderView(order.snapshot());
    });
  }
}
