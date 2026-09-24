import { Order } from './order';
import { EVENT_TYPES, EventType, OrderState } from './types';

const now = '2026-09-24T12:00:00.000Z';
const states: OrderState[] = ['CADASTRADO', 'COLETADO', 'RECEBIDO', 'ENTREGUE'];
const allowed: Record<OrderState, EventType[]> = {
  CADASTRADO: ['COLETA'],
  COLETADO: ['RECEBIMENTO', 'MOVIMENTACAO'],
  RECEBIDO: ['MOVIMENTACAO', 'EXPEDICAO', 'ENTREGA'],
  ENTREGUE: [],
};

describe('Order aggregate', () => {
  for (const state of states)
    for (const type of EVENT_TYPES) {
      it(`${state} + ${type} follows the transition table`, () => {
        const order = Order.restore({
          id: 'order',
          code: 'LAB',
          description: null,
          state,
          dispatched: false,
          version: 7,
          createdAt: now,
        });
        const before = order.snapshot();
        const result = order.apply(type);
        expect(result.accepted).toBe(allowed[state].includes(type));
        if (!result.accepted) {
          expect(order.snapshot()).toEqual(before);
          expect(order.pullEvents()).toEqual([]);
        } else {
          expect(order.snapshot().version).toBe(8);
          expect(order.pullEvents()).toHaveLength(1);
        }
      });
    }
  it('dispatch is a one-time milestone; delivery does not require it', () => {
    const order = Order.create('id', ' lab ', undefined, now);
    expect(order.snapshot().code).toBe('LAB');
    order.apply('COLETA');
    order.apply('RECEBIMENTO');
    expect(order.apply('EXPEDICAO').accepted).toBe(true);
    expect(order.snapshot().state).toBe('RECEBIDO');
    expect(order.apply('EXPEDICAO').accepted).toBe(false);
    expect(order.apply('ENTREGA').accepted).toBe(true);
  });
  it('allows delivery directly after receipt and prevents provisioning after collection', () => {
    const order = Order.create('id', 'LAB', undefined, now);
    order.assertCanProvision();
    order.apply('COLETA');
    expect(() => order.assertCanProvision()).toThrow('Provisionamento exige pedido cadastrado');
    order.apply('RECEBIMENTO');
    expect(order.apply('ENTREGA').accepted).toBe(true);
  });
});
