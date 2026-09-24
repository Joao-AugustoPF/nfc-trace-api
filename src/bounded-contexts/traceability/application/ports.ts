import { EventEnvelope } from '../../../shared-kernel/events';
import { Order, OrderSnapshot } from '../domain/order';
import { Provisioning, ProvisioningSnapshot } from '../domain/provisioning';
import { Movement, ObservationRecord, TagSnapshot } from '../domain/types';

export interface Clock {
  now(): string;
}
export interface IdGenerator {
  next(): string;
}
export interface Fingerprint {
  of(value: unknown): string;
}

export interface OrderRepository {
  get(id: string, lock?: boolean): Promise<Order | null>;
  save(order: Order): Promise<void>;
}
export interface TagRepository {
  lockUid(uid: string): Promise<void>;
  findByUid(uid: string): Promise<TagSnapshot | null>;
  get(id: string): Promise<TagSnapshot | null>;
  insert(tag: TagSnapshot): Promise<void>;
}
export interface ProvisioningRepository {
  get(id: string): Promise<Provisioning | null>;
  findLiveByOrder(orderId: string): Promise<Provisioning | null>;
  findLiveByTag(tagId: string): Promise<Provisioning | null>;
  nextEpoch(tagId: string): Promise<number>;
  save(provisioning: Provisioning): Promise<void>;
}
export interface ObservationRepository {
  lock(id: string): Promise<void>;
  get(id: string): Promise<ObservationRecord | null>;
  insert(observation: ObservationRecord): Promise<void>;
}
export interface MovementRepository {
  insert(movement: Movement): Promise<void>;
}
export interface OutboxWriter {
  append(envelopes: EventEnvelope[]): Promise<void>;
}

export interface Transaction {
  orders: OrderRepository;
  tags: TagRepository;
  provisionings: ProvisioningRepository;
  observations: ObservationRepository;
  movements: MovementRepository;
  outbox: OutboxWriter;
}
export interface UnitOfWork {
  run<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
}

export interface PageQuery {
  page: number;
  limit: number;
}
export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}
export interface ProvisioningDetails {
  provisioning: ProvisioningSnapshot;
  tag: TagSnapshot;
}
export interface HistoryEntry {
  id: string;
  type: string;
  occurredAt: string;
  receivedAt: string;
  provisioningId: string;
  observation: ObservationRecord | null;
}
export interface TraceabilityReader {
  orders(search: string | undefined, pagination: PageQuery): Promise<Page<OrderSnapshot>>;
  order(id: string): Promise<OrderSnapshot | null>;
  provisioning(id: string): Promise<ProvisioningDetails | null>;
  latestProvisioning(uid: string): Promise<ProvisioningDetails | null>;
  observation(id: string): Promise<ObservationRecord | null>;
  history(orderId: string, pagination: PageQuery): Promise<Page<HistoryEntry>>;
}
