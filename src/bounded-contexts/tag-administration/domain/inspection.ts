import { DomainError } from '../../../shared-kernel/domain-error';

export interface InspectionPlan {
  version: 1;
  purpose: 'INSPECAO_EV2';
  provisioningId: string;
  uid: string;
  epoch: number;
  strategy: string;
  credentialReference: string;
  keyVersions: number[];
}
export type InspectionState =
  'PREPARADA' | 'INSPECIONANDO' | 'INSPECIONADA' | 'INTERROMPIDA' | 'ENCERRADA';
export interface InspectionSnapshot {
  id: string;
  plan: InspectionPlan;
  planHash: string;
  actorId: string;
  station: string;
  state: InspectionState;
  createdAt: string;
  activeSession: string | null;
}
export class Inspection {
  private constructor(private readonly value: InspectionSnapshot) {}
  static restore(snapshot: InspectionSnapshot): Inspection {
    return new Inspection(structuredClone(snapshot));
  }
  static prepare(snapshot: Omit<InspectionSnapshot, 'state' | 'activeSession'>): Inspection {
    return Inspection.restore({ ...snapshot, state: 'PREPARADA', activeSession: null });
  }
  snapshot(): InspectionSnapshot {
    return structuredClone(this.value);
  }
  begin(sessionId: string, recovery: boolean): void {
    if (this.value.state === 'ENCERRADA' || this.value.state === 'INSPECIONADA')
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
    this.value.state = 'INSPECIONANDO';
  }
  interrupt(): void {
    if (this.value.state === 'INSPECIONANDO') this.value.state = 'INTERROMPIDA';
    this.value.activeSession = null;
  }
  complete(): void {
    if (this.value.state !== 'INSPECIONANDO')
      throw new DomainError(
        'NFC_SEQUENCIA_INVALIDA',
        'A inspeção não possui sessão em andamento.',
        'conflict',
      );
    this.value.state = 'INSPECIONADA';
    this.value.activeSession = null;
  }
  end(): void {
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
