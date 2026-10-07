import { DomainError } from '../../../shared-kernel/domain-error';
import { AuthenticatedActor } from '../../../shared-kernel/actor';
import { DomainEvent } from '../../../shared-kernel/events';
import { Order } from '../domain/order';
import { Decision, ObservationInput, ObservationRecord } from '../domain/types';
import { evaluateReading } from '../domain/evaluate-reading';
import { normalizeUid } from '../domain/values';
import { Clock, Fingerprint, IdGenerator, UnitOfWork } from './ports';
import { envelopes } from './event-factory';
import { observationView } from './views';
import { evaluateSdmCounter } from '../domain/sdm';
import { SdmCryptography } from './sdm-ports';
import { missingAntecedents } from '../domain/dependencies';

export function normalizeObservation(input: ObservationInput): ObservationInput {
  return {
    id: input.id.toLowerCase(),
    versaoContrato: 1,
    provisionamentoId: input.provisionamentoId.toLowerCase(),
    tipo: input.tipo,
    ocorridoEm: new Date(input.ocorridoEm).toISOString(),
    dispositivoId: input.dispositivoId.trim(),
    ...(input.operadorId !== undefined ? { operadorId: input.operadorId.trim() } : {}),
    leituraBruta: {
      uid: normalizeUid(input.leituraBruta.uid),
      ...(input.leituraBruta.ndef !== undefined ? { ndef: input.leituraBruta.ndef } : {}),
      ...(input.leituraBruta.modelo !== undefined
        ? { modelo: input.leituraBruta.modelo.trim() }
        : {}),
      ...(input.leituraBruta.tecnologias !== undefined
        ? { tecnologias: [...new Set(input.leituraBruta.tecnologias)].sort() }
        : {}),
      ...(input.leituraBruta.bytesBase64 !== undefined
        ? { bytesBase64: input.leituraBruta.bytesBase64 }
        : {}),
    },
    ...(input.latitude !== undefined ? { latitude: input.latitude } : {}),
    ...(input.longitude !== undefined ? { longitude: input.longitude } : {}),
  };
}

export class RecordObservation {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly fingerprints: Fingerprint,
    private readonly sdmCrypto?: SdmCryptography,
  ) {}

  async execute(
    raw: ObservationInput,
    correlationId: string,
    actor: AuthenticatedActor | null = null,
  ) {
    const input = normalizeObservation(raw);
    const fingerprint = this.fingerprints.of(input);
    return this.uow.run(async (tx) => {
      await tx.observations.lock(input.id);
      const existing = await tx.observations.get(input.id);
      if (existing) {
        if (existing.authenticatedActor && existing.authenticatedActor.userId !== actor?.userId) {
          throw new DomainError(
            'IDEMPOTENCIA_OPERADOR_DIVERGENTE',
            'Esta captura pertence a outro operador autenticado.',
            'conflict',
          );
        }
        if (existing.fingerprint !== fingerprint) {
          throw new DomainError(
            'IDEMPOTENCIA_CONFLITO',
            'UUID já utilizado com outro conteúdo.',
            'conflict',
          );
        }
        return observationView(existing);
      }

      let provisioning = await tx.provisionings.get(input.provisionamentoId);
      let order: Order | null = null;
      if (provisioning) {
        order = await tx.orders.get(provisioning.snapshot().orderId, true);
        provisioning = await tx.provisionings.get(input.provisionamentoId);
      }
      const now = this.clock.now();
      const previousState = order?.snapshot().state ?? null;
      const decision: Decision = {
        revision: 1,
        evaluatedAt: now,
        causeId: null,
        status: 'REJEITADA',
        dependencies: [],
        expiresAt: null,
        accepted: false,
        reason: 'VINCULO_NAO_ENCONTRADO',
        classification: 'SUSPEITO',
        evidence: 'NAO_AVALIADA',
        stateChanged: false,
        previousState,
        resultingState: previousState,
        warnings: [],
      };
      if (provisioning && order) {
        const p = provisioning.snapshot();
        const tag = await tx.tags.get(p.tagId);
        if (!tag) throw new Error('Missing tag in provisioning');
        if (p.status !== 'ATIVA') {
          decision.reason = 'VINCULO_INATIVO';
        } else {
          const evidence = evaluateReading(p, tag, input.leituraBruta);
          decision.classification = evidence.classification;
          decision.warnings = evidence.warnings;
          decision.evidence = evidence.valid ? 'IDENTIFICADA' : 'INVALIDA';
          decision.reason = evidence.reason;
          let eligible = evidence.valid;
          if (p.strategy === 'SDM') {
            if (!p.sdm || !this.sdmCrypto)
              throw new DomainError(
                'SDM_CHAVES_INDISPONIVEIS',
                'Cofre SDM indisponível.',
                'unavailable',
              );
            const result = this.sdmCrypto.verify(
              p.id,
              p.sdm,
              tag.uid,
              input.leituraBruta,
              await tx.sdm.keys(p.id),
            );
            eligible = false;
            decision.evidence = result.valid ? 'IDENTIFICADA' : 'INVALIDA';
            decision.reason = result.valid ? 'SDM_AUTENTICADA' : 'SDM_INVALIDA';
            decision.classification =
              evidence.warnings.length || !result.valid ? 'SUSPEITO' : 'REGULAR';
            decision.sdm = {
              perfil: p.sdm.profile,
              politica: p.sdm.policy,
              epoca: p.epoch,
              autenticada: result.valid,
              previamenteUtilizada: false,
              contador: result.counter,
              maiorContadorAnterior: null,
              temporalidade: 'NAO_AVALIADA',
            };
            if (result.valid && result.counter !== null) {
              // Authentication reserves evidence even when logistics rejects it. The receipt
              // remains the owner, so reconciliation must later refer to this same UUID.
              const reservation = await tx.sdm.reserve(p.id, result.counter, input.id);
              const outcome = evaluateSdmCounter(
                p.sdm.policy,
                result.counter,
                reservation.maximum,
                reservation.used,
              );
              decision.sdm.previamenteUtilizada = reservation.used;
              decision.sdm.maiorContadorAnterior =
                reservation.maximum < 0 ? null : reservation.maximum;
              decision.sdm.temporalidade = outcome.timing;
              decision.reason = outcome.reason;
              eligible = outcome.eligible;
              if (reservation.used || (outcome.timing === 'TARDIA' && p.sdm.policy === 'ESTRITA'))
                decision.classification = 'SUSPEITO';
            }
          }
          if (eligible) {
            const permission = await tx.authorization.check(actor, now);
            // Internal legacy commands can still record synchronous effects, but cannot
            // create deferred work without a verified, revocable identity.
            if (actor && !permission.allowed) decision.reason = permission.reason;
            else {
              const outcome = order.apply(input.tipo);
              decision.accepted = outcome.accepted;
              decision.reason = outcome.reason;
              decision.stateChanged = outcome.changed;
              decision.resultingState = order.snapshot().state;
              const dependencies = missingAntecedents(input.tipo, order.snapshot().state);
              if (!outcome.accepted && dependencies.length && permission.allowed) {
                decision.status = 'PENDENTE';
                decision.reason = 'AGUARDANDO_ANTECEDENTE';
                decision.dependencies = dependencies;
                const deadline = new Date(Date.parse(now) + 24 * 60 * 60 * 1000).toISOString();
                decision.expiresAt =
                  permission.expiresAt && permission.expiresAt < deadline
                    ? permission.expiresAt
                    : deadline;
              } else if (!outcome.accepted && order.snapshot().state === 'ENTREGUE') {
                decision.reason = 'PEDIDO_JA_ENTREGUE';
              }
            }
          }
        }
      }
      if (decision.accepted) decision.status = 'AUTORIZADA';
      else if (decision.sdm?.temporalidade === 'TARDIA') decision.status = 'TARDIA';
      const observation: ObservationRecord = {
        authenticatedActor: actor,
        input,
        fingerprint,
        orderId: order?.snapshot().id ?? null,
        strategy: provisioning?.snapshot().strategy ?? null,
        receivedAt: now,
        decision,
      };
      await tx.observations.insert(observation);
      if (decision.accepted && order) {
        await tx.orders.save(order);
        await tx.movements.insert({
          id: this.ids.next(),
          orderId: order.snapshot().id,
          provisioningId: input.provisionamentoId,
          observationId: input.id,
          type: input.tipo,
          occurredAt: input.ocorridoEm,
          receivedAt: now,
        });
      }
      const events: DomainEvent[] = [
        ...(order?.pullEvents() ?? []),
        {
          type: 'ObservacaoProcessada',
          aggregateId: input.id,
          payload: {
            pedidoId: observation.orderId,
            provisionamentoId: input.provisionamentoId,
            autorizada: decision.accepted,
            motivo: decision.reason,
            status: decision.status,
            revisao: decision.revision,
            dependencias: decision.dependencies,
            expiraEm: decision.expiresAt,
            classificacao: decision.classification,
            ...(decision.sdm ? { sdm: decision.sdm } : {}),
          },
        },
      ];
      await tx.outbox.append(envelopes(events, this.ids, now, correlationId, input.id, actor));
      if (decision.status === 'PENDENTE') {
        await tx.outbox.append(
          envelopes(
            [
              {
                type: 'ReconciliacaoPrazo',
                aggregateId: input.id,
                payload: { pedidoId: observation.orderId },
              },
            ],
            this.ids,
            now,
            correlationId,
            input.id,
            actor,
          ),
          decision.expiresAt!,
        );
      }
      return observationView(observation);
    });
  }
}
