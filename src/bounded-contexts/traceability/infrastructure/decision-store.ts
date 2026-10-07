import { EntityManager } from 'typeorm';
import { DecisionRepository } from '../application/ports';
import { Decision } from '../domain/types';
import { DecisionRow, ObservationRow } from './records';
import { toObservation } from './mappers';

export async function readCurrentObservation(manager: EntityManager, id: string) {
  const row = await manager.findOneBy(ObservationRow, { id });
  if (!row) return null;
  const revisions: { result: Decision }[] = await manager.query(
    `SELECT r.result FROM decision_revisions r JOIN current_decisions c
      ON c.observation_id=r.observation_id WHERE r.observation_id=$1 AND r.revision<=c.revision
      ORDER BY r.revision`,
    [id],
  );
  const current = revisions.at(-1);
  if (!current) throw new Error('Missing decision projection');
  return {
    ...toObservation(row, { observationId: id, result: current.result } as DecisionRow),
    revisions: revisions.map((r) => r.result),
  };
}

export const decisionRepository = (manager: EntityManager): DecisionRepository => ({
  async pending(orderId) {
    const rows: { id: string }[] = await manager.query(
      `SELECT o.id FROM observations o JOIN current_decisions c ON c.observation_id=o.id
        WHERE o.order_id=$1 AND c.status='PENDENTE' ORDER BY o.received_at,o.id`,
      [orderId],
    );
    const observations = [];
    for (const row of rows) observations.push((await readCurrentObservation(manager, row.id))!);
    return observations;
  },
  async pendingOrders(userId) {
    const rows: { order_id: string }[] = await manager.query(
      `SELECT DISTINCT o.order_id FROM observations o JOIN current_decisions c ON c.observation_id=o.id
        WHERE c.status='PENDENTE' AND o.authenticated_actor->>'userId'=$1 ORDER BY o.order_id`,
      [userId],
    );
    return rows.map((r) => r.order_id);
  },
  async append(id, d) {
    if (!d.revision || !d.evaluatedAt || !d.status)
      throw new Error('Decision revision metadata required');
    await manager.query(
      'INSERT INTO decision_revisions(observation_id,revision,result,evaluated_at,cause_id) VALUES ($1,$2,$3,$4,$5)',
      [id, d.revision, d, d.evaluatedAt, d.causeId ?? null],
    );
    if (d.revision === 1) {
      await manager.query('INSERT INTO current_decisions VALUES ($1,$2,$3)', [
        id,
        d.revision,
        d.status,
      ]);
    } else {
      const updated: unknown[] = await manager.query(
        `UPDATE current_decisions SET revision=$2,status=$3 WHERE observation_id=$1
          AND revision=$2-1 AND status='PENDENTE' RETURNING observation_id`,
        [id, d.revision, d.status],
      );
      if (!updated.length) throw new Error('Concurrent or terminal decision revision');
    }
  },
});
