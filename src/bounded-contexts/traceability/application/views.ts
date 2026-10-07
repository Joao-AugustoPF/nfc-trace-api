import { ndefReference } from '../domain/values';
import { OrderSnapshot } from '../domain/order';
import { ObservationRecord } from '../domain/types';
import { ProvisioningDetails } from './ports';
import { sdmUri } from '../domain/sdm';

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
  ...(p.sdm
    ? {
        sdm: {
          perfil: p.sdm.profile,
          perfilCandidato: true,
          politica: p.sdm.policy,
          referenciaChaves: p.sdm.keyReference,
          versaoChaves: p.sdm.keyVersion,
          metaReadSlot: 1,
          fileReadSlot: 2,
          uriTemplate: sdmUri(p.id),
        },
      }
    : {}),
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
  autoria: {
    tipo: o.authenticatedActor ? 'AUTENTICADA' : 'DECLARADA',
    usuarioId: o.authenticatedActor?.userId ?? null,
    sessaoId: o.authenticatedActor?.sessionId ?? null,
    perfil: o.authenticatedActor?.role ?? null,
  },
  decisao: {
    autorizada: o.decision.accepted,
    motivo: o.decision.reason,
    classificacao: o.decision.classification,
    evidencia: o.decision.evidence,
    alterouEstado: o.decision.stateChanged,
    estadoAnterior: o.decision.previousState,
    estadoResultante: o.decision.resultingState,
    avisos: o.decision.warnings,
    ...(o.decision.sdm ? { sdm: o.decision.sdm } : {}),
  },
});
