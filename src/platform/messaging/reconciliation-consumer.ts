import { EntityManager } from 'typeorm';
import { ReconcileObservations } from '../../bounded-contexts/traceability/application/reconcile-observations';
import { createTransaction } from '../../bounded-contexts/traceability/infrastructure/typeorm-unit-of-work';
import { EventEnvelope } from '../../shared-kernel/events';
import { captureAuthorization } from '../access/capture-authorization';
import { ReliableConsumer } from './consumer';

export class ReconciliationConsumer implements ReliableConsumer {
  readonly id = 'reconciliation.v1';
  constructor(private readonly reconcile: ReconcileObservations) {}
  async handle(event: EventEnvelope, manager: EntityManager) {
    const tx = createTransaction(manager, captureAuthorization);
    if (['UsuarioDesativado', 'SessoesRevogadas', 'SessaoEncerrada'].includes(event.type)) {
      for (const orderId of await tx.decisions.pendingOrders(event.aggregateId))
        await this.reconcile.execute(tx, orderId, event);
      return;
    }
    if (
      ![
        'ObservacaoProcessada',
        'MovimentacaoRegistrada',
        'VinculoEncerrado',
        'ReconciliacaoPrazo',
      ].includes(event.type)
    )
      return;
    const orderId =
      event.type === 'MovimentacaoRegistrada' ? event.aggregateId : event.payload.pedidoId;
    if (typeof orderId === 'string') await this.reconcile.execute(tx, orderId, event);
  }
}
