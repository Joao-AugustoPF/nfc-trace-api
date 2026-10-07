import { DomainError } from '../../../shared-kernel/domain-error';
import { AuthenticatedActor } from '../../../shared-kernel/actor';
import { Clock, IdGenerator, Transaction, UnitOfWork } from './ports';
import { envelopes } from './event-factory';
import { provisioningView } from './views';
import { Reading } from '../domain/types';
import { SdmCryptography } from './sdm-ports';

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
    private readonly sdmCrypto?: SdmCryptography,
  ) {}

  async execute(
    id: string,
    input: { bloqueioConfirmado: boolean; referenciaNdef?: string; leituraSdm?: Reading },
    correlationId: string,
    actor: AuthenticatedActor | null = null,
  ) {
    return this.uow.run(async (tx) => {
      const { provisioning, order, tag } = await lockProvisioning(tx, id);
      if (provisioning.snapshot().status === 'REGISTRADA') order.assertCanProvision();
      const now = this.clock.now();
      const p = provisioning.snapshot();
      let sdmVerified = false;
      if (p.strategy !== 'SDM' && input.leituraSdm !== undefined)
        throw new DomainError('SDM_CONFIGURACAO_INVALIDA', 'Leitura SDM exige estratégia SDM.');
      if (p.strategy === 'SDM' && p.status === 'REGISTRADA') {
        if (!this.sdmCrypto)
          throw new DomainError(
            'SDM_CHAVES_INDISPONIVEIS',
            'Cofre SDM indisponível.',
            'unavailable',
          );
        if (!input.leituraSdm || !p.sdm)
          throw new DomainError('SDM_ATIVACAO_INVALIDA', 'Forneça a leitura SDM de confirmação.');
        const result = this.sdmCrypto.verify(
          id,
          p.sdm,
          tag.uid,
          input.leituraSdm,
          await tx.sdm.keys(id),
        );
        if (!result.valid || result.counter === null)
          throw new DomainError('SDM_ATIVACAO_INVALIDA', 'Leitura SDM de confirmação inválida.');
        const reservation = await tx.sdm.reserve(id, result.counter, null);
        if (reservation.used)
          throw new DomainError('SDM_ATIVACAO_INVALIDA', 'Evidência de ativação já utilizada.');
        sdmVerified = true;
      }
      const changed = provisioning.activate(
        now,
        input.bloqueioConfirmado,
        input.referenciaNdef,
        sdmVerified,
      );
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
          envelopes(provisioning.pullEvents(), this.ids, now, correlationId, null, actor),
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

  async execute(id: string, correlationId: string, actor: AuthenticatedActor | null = null) {
    return this.uow.run(async (tx) => {
      const { provisioning, tag } = await lockProvisioning(tx, id);
      const now = this.clock.now();
      if (provisioning.close(now)) {
        await tx.provisionings.save(provisioning);
        await tx.outbox.append(
          envelopes(provisioning.pullEvents(), this.ids, now, correlationId, null, actor),
        );
      }
      return provisioningView({ provisioning: provisioning.snapshot(), tag });
    });
  }
}
