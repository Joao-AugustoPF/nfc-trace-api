import { EventEnvelope } from '../../../shared-kernel/events';
import { missingAntecedents } from '../domain/dependencies';
import { Decision } from '../domain/types';
import { Clock, IdGenerator, Transaction } from './ports';
import { envelopes } from './event-factory';
import { MonotonicClock } from '../../../shared-kernel/measurement';

export class ReconcileObservations {
  constructor(
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly timing?: MonotonicClock,
  ) {}

  // The caller owns the inbox transaction. No nested unit of work or ORM types here.
  async execute(tx: Transaction, orderId: string, cause: EventEnvelope) {
    const order = await tx.orders.get(orderId, true);
    if (!order) return;
    let progressed: boolean;
    do {
      progressed = false;
      const pending = await tx.decisions.pending(orderId);
      for (const o of pending) {
        const measurementStart = this.timing?.nowMs();
        const now = this.clock.now();
        const original = await tx.observations.get(o.input.id);
        if (!original) throw new Error('Missing original observation');
        const p = (await tx.provisionings.get(o.input.provisionamentoId))?.snapshot();
        const permission = await tx.authorization.check(o.authenticatedActor ?? null, now);
        const d: Decision = {
          ...o.decision,
          accepted: false,
          status: 'REJEITADA',
          stateChanged: false,
          previousState: order.snapshot().state,
          resultingState: order.snapshot().state,
          revision: o.decision.revision! + 1,
          evaluatedAt: now,
          causeId: cause.id,
        };
        if (!p || p.status !== 'ATIVA' || p.strategy !== o.strategy) d.reason = 'VINCULO_ENCERRADO';
        else if (!permission.allowed) d.reason = permission.reason;
        else if (!d.expiresAt || d.expiresAt <= now) d.reason = 'PENDENCIA_EXPIRADA';
        else if (order.snapshot().state === 'ENTREGUE') d.reason = 'PEDIDO_JA_ENTREGUE';
        else if (original.decision.evidence !== 'IDENTIFICADA') d.reason = 'EVIDENCIA_INVALIDA';
        else if (
          o.strategy === 'SDM' &&
          (!original.decision.sdm?.autenticada ||
            original.decision.sdm.temporalidade !== 'NOVA' ||
            original.decision.sdm.epoca !== p.epoch ||
            original.decision.sdm.contador === null ||
            !(await tx.sdm.owns(p.id, original.decision.sdm.contador, o.input.id)))
        )
          d.reason = 'SDM_RESERVA_INVALIDA';
        else {
          const dependencies = missingAntecedents(o.input.tipo, order.snapshot().state);
          if (dependencies.length) {
            // A repeated trigger with the same unmet conditions adds no duplicate revision.
            if (JSON.stringify(dependencies) === JSON.stringify(o.decision.dependencies)) continue;
            d.status = 'PENDENTE';
            d.reason = 'AGUARDANDO_ANTECEDENTE';
            d.dependencies = dependencies;
          } else {
            const outcome = order.apply(o.input.tipo);
            d.accepted = outcome.accepted;
            d.status = outcome.accepted ? 'AUTORIZADA' : 'REJEITADA';
            d.reason = outcome.reason;
            d.stateChanged = outcome.changed;
            d.resultingState = order.snapshot().state;
            d.dependencies = [];
          }
        }
        await tx.decisions.append(o.input.id, d);
        if (d.accepted) {
          progressed = true;
          await tx.orders.save(order);
          await tx.movements.insert({
            id: this.ids.next(),
            orderId,
            provisioningId: o.input.provisionamentoId,
            observationId: o.input.id,
            type: o.input.tipo,
            occurredAt: o.input.ocorridoEm,
            receivedAt: o.receivedAt,
          });
        }
        await tx.outbox.append(
          envelopes(
            [
              ...order.pullEvents(),
              {
                type: 'DecisaoReavaliada',
                aggregateId: o.input.id,
                payload: {
                  pedidoId: orderId,
                  provisionamentoId: o.input.provisionamentoId,
                  revisao: d.revision,
                  status: d.status,
                  autorizada: d.accepted,
                  motivo: d.reason,
                  dependencias: d.dependencies,
                  ...(d.sdm ? { sdm: d.sdm } : {}),
                },
              },
            ],
            this.ids,
            now,
            cause.correlationId,
            cause.id,
            o.authenticatedActor ?? null,
          ),
        );
        if (this.timing && measurementStart !== undefined)
          await tx.measurements.record(
            o.input.id,
            d.revision!,
            'RECONCILIACAO_ANTES_COMMIT',
            this.timing,
            measurementStart,
            this.timing.nowMs(),
          );
      }
    } while (progressed);
  }
}
