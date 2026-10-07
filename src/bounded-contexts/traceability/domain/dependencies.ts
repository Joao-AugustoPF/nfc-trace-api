import { EventType, OrderState } from './types';

// Only forward prerequisites can wait. A completed or surpassed step never regresses.
export function missingAntecedents(type: EventType, state: OrderState) {
  const collection = { event: 'COLETA' as const, state: 'COLETADO' as const };
  const receipt = { event: 'RECEBIMENTO' as const, state: 'RECEBIDO' as const };
  if (state === 'CADASTRADO') {
    if (type === 'RECEBIMENTO' || type === 'MOVIMENTACAO') return [collection];
    if (type === 'ENTREGA' || type === 'EXPEDICAO') return [collection, receipt];
  }
  if (state === 'COLETADO' && (type === 'ENTREGA' || type === 'EXPEDICAO')) return [receipt];
  return [];
}
