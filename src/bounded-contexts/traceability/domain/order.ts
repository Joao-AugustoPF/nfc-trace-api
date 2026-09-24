import { AggregateRoot } from '../../../shared-kernel/events';
import { DomainError } from '../../../shared-kernel/domain-error';
import { EventType, OrderState } from './types';
import { normalizeOrderCode } from './values';

export interface OrderSnapshot {
  id: string;
  code: string;
  description: string | null;
  state: OrderState;
  dispatched: boolean;
  version: number;
  createdAt: string;
}

export class Order extends AggregateRoot {
  private constructor(private readonly data: OrderSnapshot) {
    super();
  }

  static create(id: string, code: string, description: string | undefined, now: string): Order {
    const order = new Order({
      id,
      code: normalizeOrderCode(code),
      description: description?.trim() || null,
      state: 'CADASTRADO',
      dispatched: false,
      version: 0,
      createdAt: now,
    });
    order.raise({
      type: 'PedidoCadastrado',
      aggregateId: id,
      payload: { codigo: order.data.code },
    });
    return order;
  }

  static restore(data: OrderSnapshot): Order {
    return new Order({ ...data });
  }
  snapshot(): OrderSnapshot {
    return { ...this.data };
  }

  assertCanProvision(): void {
    if (this.data.state !== 'CADASTRADO') {
      throw new DomainError(
        'PEDIDO_JA_INICIADO',
        'Provisionamento exige pedido cadastrado.',
        'conflict',
      );
    }
  }

  apply(type: EventType): { accepted: boolean; reason: string; changed: boolean } {
    let next: OrderState | undefined;
    switch (type) {
      case 'COLETA':
        if (this.data.state === 'CADASTRADO') next = 'COLETADO';
        break;
      case 'RECEBIMENTO':
        if (this.data.state === 'COLETADO') next = 'RECEBIDO';
        break;
      case 'ENTREGA':
        if (this.data.state === 'RECEBIDO') next = 'ENTREGUE';
        break;
      case 'MOVIMENTACAO':
        if (this.data.state === 'COLETADO' || this.data.state === 'RECEBIDO')
          next = this.data.state;
        break;
      case 'EXPEDICAO':
        if (this.data.state === 'RECEBIDO' && !this.data.dispatched) {
          next = this.data.state;
          this.data.dispatched = true;
        }
        break;
      case 'PROVISIONAMENTO':
        return { accepted: false, reason: 'EVENTO_RESERVADO', changed: false };
    }
    if (!next) return { accepted: false, reason: 'SEQUENCIA_INVALIDA', changed: false };
    const changed = next !== this.data.state;
    this.data.state = next;
    this.data.version++;
    this.raise({
      type: 'MovimentacaoRegistrada',
      aggregateId: this.data.id,
      payload: { tipo: type, estado: next, versao: this.data.version },
    });
    return { accepted: true, reason: 'ACEITA', changed };
  }
}
