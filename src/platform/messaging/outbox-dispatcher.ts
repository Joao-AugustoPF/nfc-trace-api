import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { EventEnvelope } from '../../shared-kernel/events';
import { ReliableConsumer } from './consumer';

export interface ClaimedEvent {
  id: string;
  envelope: EventEnvelope;
  attempts: number;
  lock_token: string;
}
export interface OutboxOptions {
  batchSize: number;
  leaseMs: number;
}

export class OutboxDispatcher {
  constructor(
    private readonly source: DataSource,
    private readonly consumers: ReliableConsumer[],
    private readonly options: OutboxOptions,
  ) {
    if (consumers.length === 0 || new Set(consumers.map((c) => c.id)).size !== consumers.length) {
      throw new Error('Outbox requires uniquely identified consumers');
    }
  }

  async claim(): Promise<ClaimedEvent[]> {
    return this.source.transaction(async (manager) => {
      await manager.query(`UPDATE outbox SET status='FAILED', locked_until=NULL, lock_token=NULL,
        last_error='Lease expired after final attempt'
        WHERE status='PROCESSING' AND locked_until < clock_timestamp() AND attempts >= 5`);
      return manager.query(
        `WITH candidates AS (
        SELECT id FROM outbox WHERE attempts < 5 AND (
          (status='PENDING' AND available_at <= clock_timestamp()) OR
          (status='PROCESSING' AND locked_until < clock_timestamp()))
        ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT $1
      ), claimed AS (UPDATE outbox o SET status='PROCESSING', attempts=o.attempts+1,
        lock_token=$2, locked_until=clock_timestamp() + ($3 * interval '1 millisecond')
        FROM candidates c WHERE o.id=c.id RETURNING o.id, o.envelope, o.attempts, o.lock_token)
        SELECT * FROM claimed`,
        [this.options.batchSize, randomUUID(), this.options.leaseMs],
      ) as Promise<ClaimedEvent[]>;
    });
  }

  async deliver(claim: ClaimedEvent): Promise<void> {
    try {
      await this.source.transaction(async (manager) => {
        const owned: { id: string }[] = await manager.query(
          `SELECT id FROM outbox
          WHERE id=$1 AND lock_token=$2 AND status='PROCESSING' FOR UPDATE`,
          [claim.id, claim.lock_token],
        );
        if (!owned.length) return; // An expired lease may already have been reclaimed.
        for (const consumer of this.consumers) {
          const inserted: { event_id: string }[] = await manager.query(
            `INSERT INTO inbox (consumer_id,event_id)
            VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING event_id`,
            [consumer.id, claim.id],
          );
          if (inserted.length) await consumer.handle(claim.envelope, manager);
        }
        await manager.query(
          `UPDATE outbox SET status='PROCESSED', processed_at=clock_timestamp(),
          lock_token=NULL, locked_until=NULL, last_error=NULL WHERE id=$1 AND lock_token=$2`,
          [claim.id, claim.lock_token],
        );
      });
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : 'Consumer failed';
      await this.source.query(
        `UPDATE outbox SET status=CASE WHEN attempts >= 5 THEN 'FAILED' ELSE 'PENDING' END,
        available_at=clock_timestamp() + ($3 * interval '1 millisecond'), last_error=$4,
        locked_until=NULL, lock_token=NULL WHERE id=$1 AND lock_token=$2 AND status='PROCESSING'`,
        [claim.id, claim.lock_token, Math.min(1000 * 2 ** (claim.attempts - 1), 30000), message],
      );
    }
  }

  async tick(): Promise<number> {
    const claims = await this.claim();
    for (const claim of claims) await this.deliver(claim);
    return claims.length;
  }

  async retryFailed(id: string): Promise<boolean> {
    const rows: { id: string }[] = await this.source.query(
      `WITH retried AS (UPDATE outbox SET status='PENDING', attempts=0,
      available_at=clock_timestamp(), last_error=NULL, locked_until=NULL, lock_token=NULL
      WHERE id=$1 AND status='FAILED' RETURNING id) SELECT * FROM retried`,
      [id],
    );
    return rows.length > 0;
  }
}
