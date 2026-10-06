import { AuthenticatedActor } from '../../../shared-kernel/actor';
export const STRATEGIES = ['UID', 'NDEF_ESTATICO'] as const;
export type Strategy = (typeof STRATEGIES)[number];
export const EVENT_TYPES = [
  'PROVISIONAMENTO',
  'COLETA',
  'RECEBIMENTO',
  'MOVIMENTACAO',
  'EXPEDICAO',
  'ENTREGA',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export type OrderState = 'CADASTRADO' | 'COLETADO' | 'RECEBIDO' | 'ENTREGUE';
export type ProvisioningStatus = 'REGISTRADA' | 'ATIVA' | 'DESPROVISIONADA';
export type Classification = 'REGULAR' | 'SUSPEITO';

export interface Reading {
  uid: string;
  ndef?: string;
  modelo?: string;
  tecnologias?: string[];
  bytesBase64?: string;
}

export interface ObservationInput {
  id: string;
  versaoContrato: 1;
  provisionamentoId: string;
  tipo: EventType;
  ocorridoEm: string;
  dispositivoId: string;
  operadorId?: string;
  leituraBruta: Reading;
  latitude?: number;
  longitude?: number;
}

export interface Decision {
  accepted: boolean;
  reason: string;
  classification: Classification;
  evidence: 'IDENTIFICADA' | 'INVALIDA' | 'NAO_AVALIADA';
  stateChanged: boolean;
  previousState: OrderState | null;
  resultingState: OrderState | null;
  warnings: string[];
}

export interface ObservationRecord {
  authenticatedActor?: AuthenticatedActor | null;
  input: ObservationInput;
  fingerprint: string;
  orderId: string | null;
  strategy: Strategy | null;
  receivedAt: string;
  decision: Decision;
}

export interface TagSnapshot {
  id: string;
  uid: string;
  model: string;
  createdAt: string;
}

export interface Movement {
  id: string;
  orderId: string;
  provisioningId: string;
  observationId: string | null;
  type: EventType;
  occurredAt: string;
  receivedAt: string;
}
