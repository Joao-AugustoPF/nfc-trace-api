import { DataSource } from 'typeorm';
import {
  HistoryEntry,
  Page,
  PageQuery,
  ProvisioningDetails,
  TraceabilityReader,
} from '../application/ports';
import { DecisionRow, ObservationRow, OrderRecord, ProvisioningRecord, TagRecord } from './records';
import { toObservation, toOrderSnapshot, toProvisioningSnapshot, toTag } from './mappers';

export class TypeOrmTraceabilityReader implements TraceabilityReader {
  constructor(private readonly source: DataSource) {}
  async orders(search: string | undefined, pagination: PageQuery) {
    const query = this.source.getRepository(OrderRecord).createQueryBuilder('o');
    if (search)
      query.where('o.code ILIKE :search', { search: `%${search.replace(/[\\%_]/g, '\\$&')}%` });
    const [items, total] = await query
      .orderBy('o.code', 'ASC')
      .addOrderBy('o.id', 'ASC')
      .skip((pagination.page - 1) * pagination.limit)
      .take(pagination.limit)
      .getManyAndCount();
    return { items: items.map(toOrderSnapshot), total, ...pagination };
  }
  async order(id: string) {
    const row = await this.source.manager.findOneBy(OrderRecord, { id });
    return row ? toOrderSnapshot(row) : null;
  }
  async provisioning(id: string): Promise<ProvisioningDetails | null> {
    const row = await this.source.manager.findOneBy(ProvisioningRecord, { id });
    if (!row) return null;
    const tag = await this.source.manager.findOneByOrFail(TagRecord, { id: row.tagId });
    return { provisioning: toProvisioningSnapshot(row), tag: toTag(tag) };
  }
  async latestProvisioning(uid: string) {
    const tag = await this.source.manager.findOneBy(TagRecord, { uid });
    if (!tag) return null;
    const row = await this.source
      .getRepository(ProvisioningRecord)
      .findOne({ where: { tagId: tag.id }, order: { epoch: 'DESC' } });
    return row ? { provisioning: toProvisioningSnapshot(row), tag: toTag(tag) } : null;
  }
  async observation(id: string) {
    const row = await this.source.manager.findOneBy(ObservationRow, { id });
    if (!row) return null;
    const decision = await this.source.manager.findOneByOrFail(DecisionRow, { observationId: id });
    return toObservation(row, decision);
  }
  async history(orderId: string, pagination: PageQuery): Promise<Page<HistoryEntry>> {
    // Provisioning is system-originated. Other accepted movements already have an observation.
    const union = `SELECT id, input->>'tipo' AS type, input->>'ocorridoEm' AS occurred_at,
      received_at, provisioning_id, id AS observation_id FROM observations WHERE order_id = $1
      UNION ALL SELECT id, type, occurred_at::text, received_at, provisioning_id, NULL::uuid
      FROM movements WHERE order_id = $1 AND type = 'PROVISIONAMENTO'`;
    const rows: {
      id: string;
      type: string;
      occurred_at: string;
      received_at: Date;
      provisioning_id: string;
      observation_id: string | null;
    }[] = await this.source.query(
      `SELECT * FROM (${union}) h ORDER BY received_at, id LIMIT $2 OFFSET $3`,
      [orderId, pagination.limit, (pagination.page - 1) * pagination.limit],
    );
    const counts: { total: string }[] = await this.source.query(
      `SELECT COUNT(*) AS total FROM (${union}) h`,
      [orderId],
    );
    const items = await Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        type: row.type,
        occurredAt: new Date(row.occurred_at).toISOString(),
        receivedAt: row.received_at.toISOString(),
        provisioningId: row.provisioning_id,
        observation: row.observation_id ? await this.observation(row.observation_id) : null,
      })),
    );
    return { items, total: Number(counts[0]!.total), ...pagination };
  }
}
