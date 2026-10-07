import { ndefReference } from '../domain/values';
import { OrderSnapshot } from '../domain/order';
import { Decision, ObservationRecord } from '../domain/types';
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
  decisao: decisionView(o.decision, o.receivedAt),
  historicoDecisoes: (o.revisions ?? [o.decision]).map((d) => decisionView(d, o.receivedAt)),
});

export const decisionView = (d: Decision, receivedAt: string) => ({
  revisao: d.revision ?? 1,
  status:
    d.status ??
    (d.accepted ? 'AUTORIZADA' : d.sdm?.temporalidade === 'TARDIA' ? 'TARDIA' : 'REJEITADA'),
  avaliadaEm: d.evaluatedAt ?? receivedAt,
  causaId: d.causeId ?? null,
  expiraEm: d.expiresAt ?? null,
  dependencias: (d.dependencies ?? []).map((dep) => ({
    tipo: dep.event,
    estadoNecessario: dep.state,
  })),
  autorizada: d.accepted,
  motivo: d.reason,
  classificacao: d.classification,
  evidencia: d.evidence,
  alterouEstado: d.stateChanged,
  estadoAnterior: d.previousState,
  estadoResultante: d.resultingState,
  avisos: d.warnings,
  ...(d.sdm ? { sdm: d.sdm } : {}),
});
