import { DomainError } from '../../../shared-kernel/domain-error';
import { AuthenticatedActor } from '../../../shared-kernel/actor';
import { Provisioning } from '../domain/provisioning';
import { Strategy } from '../domain/types';
import { normalizeUid } from '../domain/values';
import { Clock, IdGenerator, UnitOfWork } from './ports';
import { envelopes } from './event-factory';
import { provisioningView } from './views';

export class ProvisionTag {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(
    input: { pedidoId: string; uid: string; modelo: string; estrategia: string },
    correlationId: string,
    actor: AuthenticatedActor | null = null,
  ) {
    if (!['UID', 'NDEF_ESTATICO'].includes(input.estrategia)) {
      throw new DomainError(
        'ESTRATEGIA_INDISPONIVEL',
        'Estratégia dinâmica ainda não disponível.',
        'unsupported',
      );
    }
    const uid = normalizeUid(input.uid);
    return this.uow.run(async (tx) => {
      const order = await tx.orders.get(input.pedidoId, true);
      if (!order)
        throw new DomainError('PEDIDO_NAO_ENCONTRADO', 'Pedido não encontrado.', 'not-found');
      order.assertCanProvision();
      await tx.tags.lockUid(uid);
      if (await tx.provisionings.findLiveByOrder(input.pedidoId)) {
        throw new DomainError(
          'PEDIDO_COM_ETIQUETA',
          'O pedido já possui vínculo vigente.',
          'conflict',
        );
      }
      const now = this.clock.now();
      let tag = await tx.tags.findByUid(uid);
      if (tag && (await tx.provisionings.findLiveByTag(tag.id))) {
        throw new DomainError(
          'ETIQUETA_VINCULADA',
          'A etiqueta já possui vínculo vigente.',
          'conflict',
        );
      }
      if (tag && tag.model !== input.modelo.trim()) {
        throw new DomainError(
          'MODELO_DIVERGENTE',
          'Modelo difere do cadastro da etiqueta.',
          'conflict',
        );
      }
      if (!tag) {
        tag = { id: this.ids.next(), uid, model: input.modelo.trim(), createdAt: now };
        await tx.tags.insert(tag);
      }
      const provisioning = Provisioning.register({
        id: this.ids.next(),
        tagId: tag.id,
        orderId: input.pedidoId,
        strategy: input.estrategia as Strategy,
        epoch: await tx.provisionings.nextEpoch(tag.id),
        createdAt: now,
      });
      await tx.provisionings.save(provisioning);
      await tx.outbox.append(
        envelopes(provisioning.pullEvents(), this.ids, now, correlationId, null, actor),
      );
      return provisioningView({ provisioning: provisioning.snapshot(), tag });
    });
  }
}
