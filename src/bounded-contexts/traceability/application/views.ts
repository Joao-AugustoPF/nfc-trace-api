import { ndefReference } from '../domain/values';
import { OrderSnapshot } from '../domain/order';
import { ObservationRecord } from '../domain/types';
import { ProvisioningDetails } from './ports';

export const orderView = (o: OrderSnapshot) => ({
  id: o.id,
  codigo: o.code,
  descricao: o.description,
  estado: o.state,
  expedido: o.dispatched,
  versao: o.version,
  criadoEm: o.createdAt,
});

export const provisioningView = ({ provisioning: p, tag }: ProvisioningDetails) => ({
  id: p.id,
  etiquetaId: tag.id,
  uid: tag.uid,
  modelo: tag.model,
  pedidoId: p.orderId,
  estrategia: p.strategy,
  epoca: p.epoch,
  status: p.status,
  referenciaNdef: p.strategy === 'NDEF_ESTATICO' ? ndefReference(p.id) : null,
  criadoEm: p.createdAt,
  ativadoEm: p.activatedAt,
  encerradoEm: p.closedAt,
});

export const observationView = (o: ObservationRecord) => ({
  ...o.input,
  armazenada: true as const,
  pedidoId: o.orderId,
  estrategia: o.strategy,
  recebidoEm: o.receivedAt,
  decisao: {
    autorizada: o.decision.accepted,
    motivo: o.decision.reason,
    classificacao: o.decision.classification,
    evidencia: o.decision.evidence,
    alterouEstado: o.decision.stateChanged,
    estadoAnterior: o.decision.previousState,
    estadoResultante: o.decision.resultingState,
    avisos: o.decision.warnings,
  },
});
