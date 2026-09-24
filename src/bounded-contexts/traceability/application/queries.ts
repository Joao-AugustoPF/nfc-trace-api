import { DomainError } from '../../../shared-kernel/domain-error';
import { normalizeUid } from '../domain/values';
import { Page, PageQuery, TraceabilityReader } from './ports';
import { observationView, orderView, provisioningView } from './views';

const pageView = <T, U>(page: Page<T>, map: (item: T) => U) => ({
  itens: page.items.map(map),
  total: page.total,
  pagina: page.page,
  limite: page.limit,
});
function required<T>(value: T | null, code: string): T {
  if (value === null) throw new DomainError(code, 'Registro não encontrado.', 'not-found');
  return value;
}

export class TraceabilityQueries {
  constructor(private readonly reader: TraceabilityReader) {}
  async orders(search: string | undefined, pagination: PageQuery) {
    return pageView(await this.reader.orders(search?.trim(), pagination), orderView);
  }
  async order(id: string) {
    return orderView(required(await this.reader.order(id), 'PEDIDO_NAO_ENCONTRADO'));
  }
  async provisioning(id: string) {
    return provisioningView(required(await this.reader.provisioning(id), 'VINCULO_NAO_ENCONTRADO'));
  }
  async tag(uid: string) {
    return provisioningView(
      required(await this.reader.latestProvisioning(normalizeUid(uid)), 'ETIQUETA_NAO_ENCONTRADA'),
    );
  }
  async observation(id: string) {
    return observationView(required(await this.reader.observation(id), 'EVENTO_NAO_ENCONTRADO'));
  }
  async history(id: string, pagination: PageQuery) {
    required(await this.reader.order(id), 'PEDIDO_NAO_ENCONTRADO');
    return pageView(await this.reader.history(id, pagination), (item) => ({
      id: item.id,
      tipo: item.type,
      ocorridoEm: item.occurredAt,
      recebidoEm: item.receivedAt,
      provisionamentoId: item.provisioningId,
      origem: item.observation ? 'CAPTURA' : 'SISTEMA',
      autoria: item.observation ? observationView(item.observation).autoria : null,
      decisao: item.observation
        ? observationView(item.observation).decisao
        : {
            autorizada: true,
            motivo: 'VINCULO_ATIVADO',
            classificacao: 'REGULAR',
            evidencia: 'NAO_AVALIADA',
            alterouEstado: false,
            estadoAnterior: 'CADASTRADO',
            estadoResultante: 'CADASTRADO',
            avisos: [],
          },
    }));
  }
}
