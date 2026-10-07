import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { DomainError } from '../../../shared-kernel/domain-error';
import { Transaction, UnitOfWork } from '../application/ports';
import {
  OrderRecord,
  TagRecord,
  ProvisioningRecord,
  ObservationRow,
  DecisionRow,
  MovementRecord,
} from './records';
import { toOrder, toTag, toProvisioning, toObservation } from './mappers';
import { SealedSdmKeys } from '../application/sdm-ports';

export function createTransaction(manager: EntityManager): Transaction {
  return {
    sdm: {
      async insertKeys(id, _configuration, keys) {
        await manager.query('INSERT INTO sdm_keys (provisioning_id,sealed) VALUES ($1,$2)', [
          id,
          JSON.stringify(keys),
        ]);
        await manager.query('INSERT INTO sdm_counter_state (provisioning_id) VALUES ($1)', [id]);
      },
      async keys(id) {
        const rows: { sealed: SealedSdmKeys }[] = await manager.query(
          'SELECT sealed FROM sdm_keys WHERE provisioning_id=$1',
          [id],
        );
        if (!rows[0])
          throw new DomainError(
            'SDM_CHAVES_INDISPONIVEIS',
            'Chaves SDM indisponíveis.',
            'unavailable',
          );
        return rows[0].sealed;
      },
      async reserve(id, counter, observationId) {
        const rows: { maximum: number }[] = await manager.query(
          'SELECT maximum FROM sdm_counter_state WHERE provisioning_id=$1 FOR UPDATE',
          [id],
        );
        if (!rows[0])
          throw new DomainError(
            'SDM_CHAVES_INDISPONIVEIS',
            'Estado SDM indisponível.',
            'unavailable',
          );
        const maximum = rows[0].maximum;
        const inserted: unknown[] = await manager.query(
          'INSERT INTO sdm_evidence (provisioning_id,counter,observation_id) VALUES ($1,$2,$3) ON CONFLICT (provisioning_id,counter) DO NOTHING RETURNING counter',
          [id, counter, observationId],
        );
        if (inserted.length)
          await manager.query(
            'UPDATE sdm_counter_state SET maximum=GREATEST(maximum,$2) WHERE provisioning_id=$1',
            [id, counter],
          );
        return { used: !inserted.length, maximum };
      },
    },
    orders: {
      async get(id, lock = false) {
        const row = await manager.findOne(OrderRecord, {
          where: { id },
          ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}),
        });
        return row ? toOrder(row) : null;
      },
      async save(order) {
        const s = order.snapshot();
        await manager.save(OrderRecord, { ...s, createdAt: new Date(s.createdAt) });
      },
    },
    tags: {
      async lockUid(uid) {
        await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `tag:${uid}`,
        ]);
      },
      async findByUid(uid) {
        const row = await manager.findOneBy(TagRecord, { uid });
        return row ? toTag(row) : null;
      },
      async get(id) {
        const row = await manager.findOneBy(TagRecord, { id });
        return row ? toTag(row) : null;
      },
      async insert(tag) {
        await manager.insert(TagRecord, { ...tag, createdAt: new Date(tag.createdAt) });
      },
    },
    provisionings: {
      async get(id) {
        const row = await manager.findOneBy(ProvisioningRecord, { id });
        return row ? toProvisioning(row) : null;
      },
      async findLiveByOrder(orderId) {
        const row = await manager
          .createQueryBuilder(ProvisioningRecord, 'p')
          .where('p.order_id = :orderId AND p.status <> :closed', {
            orderId,
            closed: 'DESPROVISIONADA',
          })
          .getOne();
        return row ? toProvisioning(row) : null;
      },
      async findLiveByTag(tagId) {
        const row = await manager
          .createQueryBuilder(ProvisioningRecord, 'p')
          .where('p.tag_id = :tagId AND p.status <> :closed', { tagId, closed: 'DESPROVISIONADA' })
          .getOne();
        return row ? toProvisioning(row) : null;
      },
      async nextEpoch(tagId) {
        const rows: { epoch: number }[] = await manager.query(
          'SELECT COALESCE(MAX(epoch), 0) + 1 AS epoch FROM provisionings WHERE tag_id = $1',
          [tagId],
        );
        return rows[0]!.epoch;
      },
      async save(provisioning) {
        const s = provisioning.snapshot();
        await manager.save(ProvisioningRecord, {
          ...s,
          createdAt: new Date(s.createdAt),
          activatedAt: s.activatedAt ? new Date(s.activatedAt) : null,
          closedAt: s.closedAt ? new Date(s.closedAt) : null,
        });
      },
    },
    observations: {
      async lock(id) {
        await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `observation:${id}`,
        ]);
      },
      async get(id) {
        const row = await manager.findOneBy(ObservationRow, { id });
        if (!row) return null;
        const decision = await manager.findOneByOrFail(DecisionRow, { observationId: id });
        return toObservation(row, decision);
      },
      async insert(o) {
        await manager.insert(ObservationRow, {
          authenticatedActor: o.authenticatedActor ?? null,
          id: o.input.id,
          orderId: o.orderId,
          provisioningId: o.input.provisionamentoId,
          strategy: o.strategy,
          fingerprint: o.fingerprint,
          input: o.input,
          receivedAt: new Date(o.receivedAt),
        });
        await manager.insert(DecisionRow, { observationId: o.input.id, result: o.decision });
      },
    },
    movements: {
      async insert(m) {
        await manager.insert(MovementRecord, {
          ...m,
          occurredAt: new Date(m.occurredAt),
          receivedAt: new Date(m.receivedAt),
        });
      },
    },
    outbox: {
      async append(events) {
        for (const event of events) {
          await manager.query('INSERT INTO outbox (id, envelope, created_at) VALUES ($1, $2, $3)', [
            event.id,
            event,
            event.occurredAt,
          ]);
        }
      },
    },
  };
}

export class TypeOrmUnitOfWork implements UnitOfWork {
  constructor(private readonly source: DataSource) {}
  async run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    try {
      return await this.source.transaction('READ COMMITTED', (manager) =>
        work(createTransaction(manager)),
      );
    } catch (error) {
      if (error instanceof QueryFailedError) {
        const driver = error.driverError as { code?: string; constraint?: string };
        if (driver.code === '23505') {
          const codes: Record<string, string> = {
            orders_code_key: 'CODIGO_PEDIDO_DUPLICADO',
            live_order_binding: 'PEDIDO_COM_ETIQUETA',
            live_tag_binding: 'ETIQUETA_VINCULADA',
          };
          throw new DomainError(
            codes[driver.constraint ?? ''] ?? 'REGISTRO_DUPLICADO',
            'O registro conflita com dados existentes.',
            'conflict',
          );
        }
      }
      throw error;
    }
  }
}
