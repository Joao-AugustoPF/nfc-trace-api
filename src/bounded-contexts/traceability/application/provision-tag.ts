import { DomainError } from '../../../shared-kernel/domain-error';
import { AuthenticatedActor } from '../../../shared-kernel/actor';
import { Provisioning } from '../domain/provisioning';
import { Strategy } from '../domain/types';
import { normalizeUid } from '../domain/values';
import { Clock, IdGenerator, UnitOfWork } from './ports';
import { envelopes } from './event-factory';
import { provisioningView } from './views';
import { SDM_PROFILE, SDM_POLICIES, SdmPolicy } from '../domain/sdm';
import { SdmCryptography } from './sdm-ports';

export class ProvisionTag {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly sdmCrypto?: SdmCryptography,
  ) {}

  async execute(
    input: {
      pedidoId: string;
      uid: string;
      modelo: string;
      estrategia: string;
      politicaSdm?: string;
    },
    correlationId: string,
    actor: AuthenticatedActor | null = null,
  ) {
    if (!['UID', 'NDEF_ESTATICO', 'SDM'].includes(input.estrategia)) {
      throw new DomainError(
        'ESTRATEGIA_INDISPONIVEL',
        'Estratégia dinâmica ainda não disponível.',
        'unsupported',
      );
    }
    const uid = normalizeUid(input.uid);
    if (input.estrategia === 'SDM') {
      if (!SDM_POLICIES.includes(input.politicaSdm as SdmPolicy) || uid.length !== 14)
        throw new DomainError(
          'SDM_CONFIGURACAO_INVALIDA',
          'SDM exige UID de sete bytes e política explícita.',
        );
      if (!this.sdmCrypto)
        throw new DomainError('SDM_CHAVES_INDISPONIVEIS', 'Cofre SDM indisponível.', 'unavailable');
    } else if (input.politicaSdm !== undefined) {
      throw new DomainError('SDM_CONFIGURACAO_INVALIDA', 'Política SDM exige estratégia SDM.');
    }
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
      const id = this.ids.next();
      const sdm =
        input.estrategia === 'SDM'
          ? {
              profile: SDM_PROFILE,
              policy: input.politicaSdm as SdmPolicy,
              keyReference: this.ids.next(),
              keyVersion: 1 as const,
            }
          : null;
      const keys = sdm ? this.sdmCrypto!.generate(id, sdm) : null;
      const provisioning = Provisioning.register({
        id,
        sdm,
        tagId: tag.id,
        orderId: input.pedidoId,
        strategy: input.estrategia as Strategy,
        epoch: await tx.provisionings.nextEpoch(tag.id),
        createdAt: now,
      });
      await tx.provisionings.save(provisioning);
      if (sdm && keys) await tx.sdm.insertKeys(id, sdm, keys);
      await tx.outbox.append(
        envelopes(provisioning.pullEvents(), this.ids, now, correlationId, null, actor),
      );
      return provisioningView({ provisioning: provisioning.snapshot(), tag });
    });
  }
}
