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
          if (evidence.valid) {
            const outcome = order.apply(input.tipo);
            decision.accepted = outcome.accepted;
            decision.reason = outcome.reason;
            decision.stateChanged = outcome.changed;
            decision.resultingState = order.snapshot().state;
          }
        }
      }
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
            classificacao: decision.classification,
          },
        },
      ];
      await tx.outbox.append(envelopes(events, this.ids, now, correlationId, input.id, actor));
      return observationView(observation);
    });
  }
}
