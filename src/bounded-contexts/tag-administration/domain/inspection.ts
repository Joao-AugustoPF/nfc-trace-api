import { DomainError } from '../../../shared-kernel/domain-error';
import { PersonalizationPlan } from './personalization-plan';

export interface InspectionPlan {
  version: 1;
  purpose: 'INSPECAO_EV2' | 'PERSONALIZACAO';
  provisioningId: string;
  uid: string;
  epoch: number;
  strategy: string;
  credentialReference: string;
  keyVersions: number[];
  personalization?: PersonalizationPlan;
}
export type InspectionState =
  | 'PREPARADA'
  | 'INSPECIONANDO'
  | 'INSPECIONADA'
  | 'PERSONALIZANDO'
  | 'PERSONALIZADA'
  | 'INTERROMPIDA'
  | 'ENCERRADA';
export interface InspectionSnapshot {
  id: string;
  plan: InspectionPlan;
  planHash: string;
  actorId: string;
  station: string;
  state: InspectionState;
  createdAt: string;
  activeSession: string | null;
  mutationIssued: boolean;
  dataVerified: boolean;
  physicalOutcome: 'NAO_ALTERADA' | 'NAO_CONFIRMADA' | 'CONFERIDA';
}
export class Inspection {
  private constructor(private readonly value: InspectionSnapshot) {}
  static restore(snapshot: InspectionSnapshot): Inspection {
    return new Inspection(structuredClone(snapshot));
  }
  static prepare(
    snapshot: Omit<
      InspectionSnapshot,
      'state' | 'activeSession' | 'mutationIssued' | 'dataVerified' | 'physicalOutcome'
    >,
  ): Inspection {
    return Inspection.restore({
      ...snapshot,
      state: 'PREPARADA',
      activeSession: null,
      mutationIssued: false,
      dataVerified: false,
      physicalOutcome: 'NAO_ALTERADA',
    });
  }
  snapshot(): InspectionSnapshot {
    return structuredClone(this.value);
  }
  begin(sessionId: string, recovery: boolean): void {
    if (['ENCERRADA', 'INSPECIONADA', 'PERSONALIZADA'].includes(this.value.state))
      throw new DomainError(
        'NFC_INSPECAO_FINALIZADA',
        'Esta inspeção já foi finalizada.',
        'conflict',
      );
    if (this.value.activeSession)
      throw new DomainError(
        'NFC_SESSAO_EM_USO',
        'Encerre a sessão RF anterior antes de continuar.',
        'conflict',
      );
    if (this.value.state === 'INTERROMPIDA' && !recovery)
      throw new DomainError(
        'NFC_RECUPERACAO_EXPLICITA',
        'Inicie outra sessão RF e confirme a recuperação.',
        'conflict',
      );
    this.value.activeSession = sessionId;
    this.value.state =
      this.value.plan.purpose === 'PERSONALIZACAO' ? 'PERSONALIZANDO' : 'INSPECIONANDO';
  }
  issueMutation(invalidatesData = false): void {
    if (this.value.state !== 'PERSONALIZANDO')
      throw new DomainError(
        'NFC_SEQUENCIA_INVALIDA',
        'A operação não permite gravação.',
        'conflict',
      );
    this.value.mutationIssued = true;
    this.value.physicalOutcome = 'NAO_CONFIRMADA';
    if (invalidatesData) this.value.dataVerified = false;
  }
  verifyData(): void {
    if (this.value.state !== 'PERSONALIZANDO')
      throw new DomainError(
        'NFC_SEQUENCIA_INVALIDA',
        'A conferência exige personalização em andamento.',
        'conflict',
      );
    this.value.dataVerified = true;
  }
  interrupt(): void {
    if (['INSPECIONANDO', 'PERSONALIZANDO'].includes(this.value.state))
      this.value.state = 'INTERROMPIDA';
    this.value.activeSession = null;
  }
  complete(): void {
    if (!['INSPECIONANDO', 'PERSONALIZANDO'].includes(this.value.state))
      throw new DomainError(
        'NFC_SEQUENCIA_INVALIDA',
        'A inspeção não possui sessão em andamento.',
        'conflict',
      );
    if (this.value.plan.purpose === 'PERSONALIZACAO') {
      if (!this.value.dataVerified)
        throw new DomainError(
          'NFC_DADOS_NAO_CONFERIDOS',
          'Confirme o conteúdo antes de concluir.',
          'conflict',
        );
      this.value.physicalOutcome = 'CONFERIDA';
    }
    this.value.state =
      this.value.plan.purpose === 'PERSONALIZACAO' ? 'PERSONALIZADA' : 'INSPECIONADA';
    this.value.activeSession = null;
  }
  assertCanEnd(): void {
    if (this.value.mutationIssued && this.value.physicalOutcome !== 'CONFERIDA')
      throw new DomainError(
        'NFC_RECUPERACAO_OBRIGATORIA',
        'Recupere e confira a tag antes de encerrar a operação.',
        'conflict',
      );
  }
  end(): void {
    this.assertCanEnd();
    this.value.state = 'ENCERRADA';
    this.value.activeSession = null;
  }
}

export function validateInventory(uid: string, versions: readonly number[]): void {
  if (
    !/^[0-9A-F]{14}$/.test(uid) ||
    versions.length !== 5 ||
    versions.some((v) => !Number.isInteger(v) || v < 0 || v > 255)
  )
    throw new DomainError(
      'NFC_INVENTARIO_INVALIDO',
      'Informe UID de sete bytes e versões dos cinco slots.',
    );
}
