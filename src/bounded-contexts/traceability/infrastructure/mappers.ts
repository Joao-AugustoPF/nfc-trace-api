import { Order, OrderSnapshot } from '../domain/order';
import { Provisioning, ProvisioningSnapshot } from '../domain/provisioning';
import { ObservationRecord, TagSnapshot } from '../domain/types';
import { DecisionRow, ObservationRow, OrderRecord, ProvisioningRecord, TagRecord } from './records';

export const toOrderSnapshot = (row: OrderRecord): OrderSnapshot => ({
  ...row,
  createdAt: row.createdAt.toISOString(),
});
export const toOrder = (row: OrderRecord): Order => Order.restore(toOrderSnapshot(row));
export const toTag = (row: TagRecord): TagSnapshot => ({
  ...row,
  createdAt: row.createdAt.toISOString(),
});
export const toProvisioningSnapshot = (row: ProvisioningRecord): ProvisioningSnapshot => ({
  ...row,
  createdAt: row.createdAt.toISOString(),
  activatedAt: row.activatedAt?.toISOString() ?? null,
  closedAt: row.closedAt?.toISOString() ?? null,
});
export const toProvisioning = (row: ProvisioningRecord): Provisioning =>
  Provisioning.restore(toProvisioningSnapshot(row));
export const toObservation = (row: ObservationRow, decision: DecisionRow): ObservationRecord => ({
  input: row.input,
  fingerprint: row.fingerprint,
  orderId: row.orderId,
  strategy: row.strategy,
  receivedAt: row.receivedAt.toISOString(),
  decision: decision.result,
});
