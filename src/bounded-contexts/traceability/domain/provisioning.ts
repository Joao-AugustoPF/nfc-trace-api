import { AggregateRoot } from '../../../shared-kernel/events';
import { DomainError } from '../../../shared-kernel/domain-error';
import { ProvisioningStatus, Strategy } from './types';
import { ndefReference } from './values';
import { SDM_PROFILE, SDM_POLICIES, SdmConfiguration } from './sdm';

export interface ProvisioningSnapshot {
  sdm?: SdmConfiguration | null;
  id: string;
  tagId: string;
  orderId: string;
  strategy: Strategy;
  epoch: number;
  status: ProvisioningStatus;
  createdAt: string;
  activatedAt: string | null;
  closedAt: string | null;
}

export class Provisioning extends AggregateRoot {
  private constructor(private readonly data: ProvisioningSnapshot) {
    super();
  }

  static register(
    data: Omit<ProvisioningSnapshot, 'status' | 'activatedAt' | 'closedAt'>,
  ): Provisioning {
    if (!['UID', 'NDEF_ESTATICO', 'SDM'].includes(data.strategy)) {
      throw new DomainError(
        'ESTRATEGIA_INDISPONIVEL',
        'SDM não está disponível nesta versão.',
        'unsupported',
      );
    }
    if (
      data.strategy === 'SDM'
        ? !data.sdm ||
          data.sdm.profile !== SDM_PROFILE ||
          !SDM_POLICIES.includes(data.sdm.policy) ||
          data.sdm.keyVersion !== 1
        : !!data.sdm
    ) {
      throw new DomainError('SDM_CONFIGURACAO_INVALIDA', 'Configuração SDM incompatível.');
    }
    const provisioning = new Provisioning({
      ...data,
      ...(data.sdm ? { sdm: { ...data.sdm } } : {}),
      status: 'REGISTRADA',
      activatedAt: null,
      closedAt: null,
    });
    provisioning.raise({
      type: 'EtiquetaRegistrada',
      aggregateId: data.id,
      payload: {
        pedidoId: data.orderId,
        etiquetaId: data.tagId,
        epoca: data.epoch,
        estrategia: data.strategy,
      },
    });
    return provisioning;
  }

  static restore(data: ProvisioningSnapshot): Provisioning {
    return new Provisioning({ ...data, ...(data.sdm ? { sdm: { ...data.sdm } } : {}) });
  }
  snapshot(): ProvisioningSnapshot {
    return { ...this.data, ...(this.data.sdm ? { sdm: { ...this.data.sdm } } : {}) };
  }

  activate(
    now: string,
    confirmed: boolean,
    writtenReference?: string,
    sdmVerified = false,
  ): boolean {
    if (!confirmed)
      throw new DomainError(
        'BLOQUEIO_NAO_CONFIRMADO',
        'Confirme a configuração física da etiqueta.',
      );
    if (
      this.data.strategy === 'NDEF_ESTATICO' &&
      writtenReference !== ndefReference(this.data.id)
    ) {
      throw new DomainError(
        'NDEF_DIVERGENTE',
        'A referência NDEF confirmada diverge do provisionamento.',
      );
    }
    if (this.data.status === 'DESPROVISIONADA') {
      throw new DomainError('VINCULO_ENCERRADO', 'O provisionamento está encerrado.', 'conflict');
    }
    if (this.data.status === 'ATIVA') return false;
    if (this.data.strategy === 'SDM' && !sdmVerified)
      throw new DomainError(
        'SDM_ATIVACAO_INVALIDA',
        'Ativação SDM exige leitura criptograficamente válida.',
      );
    this.data.status = 'ATIVA';
    this.data.activatedAt = now;
    this.raise({
      type: 'EtiquetaAtivada',
      aggregateId: this.data.id,
      payload: { pedidoId: this.data.orderId, etiquetaId: this.data.tagId, epoca: this.data.epoch },
    });
    return true;
  }

  close(now: string): boolean {
    if (this.data.status === 'DESPROVISIONADA') return false;
    this.data.status = 'DESPROVISIONADA';
    this.data.closedAt = now;
    this.raise({
      type: 'VinculoEncerrado',
      aggregateId: this.data.id,
      payload: { pedidoId: this.data.orderId, etiquetaId: this.data.tagId, epoca: this.data.epoch },
    });
    return true;
  }
}
