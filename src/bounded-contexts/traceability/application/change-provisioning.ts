import { DomainError } from '../../../shared-kernel/domain-error';
import { Clock, IdGenerator, Transaction, UnitOfWork } from './ports';
import { envelopes } from './event-factory';
import { provisioningView } from './views';

async function lockProvisioning(tx: Transaction, id: string) {
  let provisioning = await tx.provisionings.get(id);
  if (!provisioning)
    throw new DomainError('VINCULO_NAO_ENCONTRADO', 'Provisionamento não encontrado.', 'not-found');
  const order = await tx.orders.get(provisioning.snapshot().orderId, true);
  if (!order) throw new Error('Missing order in provisioning');
  // All lifecycle changes and observations acquire the same order lock first.
  provisioning = await tx.provisionings.get(id);
  if (!provisioning) throw new Error('Missing provisioning after lock');
  const tag = await tx.tags.get(provisioning.snapshot().tagId);
  if (!tag) throw new Error('Missing tag in provisioning');
  return { provisioning, order, tag };
}

export class ActivateProvisioning {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(
    id: string,
    input: { bloqueioConfirmado: boolean; referenciaNdef?: string },
    correlationId: string,
  ) {
    return this.uow.run(async (tx) => {
      const { provisioning, order, tag } = await lockProvisioning(tx, id);
      if (provisioning.snapshot().status === 'REGISTRADA') order.assertCanProvision();
      const now = this.clock.now();
      const changed = provisioning.activate(now, input.bloqueioConfirmado, input.referenciaNdef);
      if (changed) {
        await tx.provisionings.save(provisioning);
        await tx.movements.insert({
          id: this.ids.next(),
          orderId: order.snapshot().id,
          provisioningId: id,
          observationId: null,
          type: 'PROVISIONAMENTO',
          occurredAt: now,
          receivedAt: now,
        });
        await tx.outbox.append(
          envelopes(provisioning.pullEvents(), this.ids, now, correlationId, null),
        );
      }
      return provisioningView({ provisioning: provisioning.snapshot(), tag });
    });
  }
}

export class CloseProvisioning {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(id: string, correlationId: string) {
    return this.uow.run(async (tx) => {
      const { provisioning, tag } = await lockProvisioning(tx, id);
      const now = this.clock.now();
      if (provisioning.close(now)) {
        await tx.provisionings.save(provisioning);
        await tx.outbox.append(
          envelopes(provisioning.pullEvents(), this.ids, now, correlationId, null),
        );
      }
      return provisioningView({ provisioning: provisioning.snapshot(), tag });
    });
  }
}
