import { Column, Entity, PrimaryColumn } from 'typeorm';
import { AuthenticatedActor } from '../../../shared-kernel/actor';
import {
  Decision,
  ObservationInput,
  ProvisioningStatus,
  Strategy,
  EventType,
  OrderState,
} from '../domain/types';

@Entity('orders')
export class OrderRecord {
  @PrimaryColumn('uuid') id!: string;
  @Column('varchar', { length: 64 }) code!: string;
  @Column('text', { nullable: true }) description!: string | null;
  @Column('varchar') state!: OrderState;
  @Column('boolean') dispatched!: boolean;
  @Column('integer') version!: number;
  @Column('timestamptz', { name: 'created_at' }) createdAt!: Date;
}

@Entity('tags')
export class TagRecord {
  @PrimaryColumn('uuid') id!: string;
  @Column('varchar', { length: 20 }) uid!: string;
  @Column('varchar', { length: 64 }) model!: string;
  @Column('timestamptz', { name: 'created_at' }) createdAt!: Date;
}

@Entity('provisionings')
export class ProvisioningRecord {
  @PrimaryColumn('uuid') id!: string;
  @Column('uuid', { name: 'tag_id' }) tagId!: string;
  @Column('uuid', { name: 'order_id' }) orderId!: string;
  @Column('varchar') strategy!: Strategy;
  @Column('integer') epoch!: number;
  @Column('varchar') status!: ProvisioningStatus;
  @Column('timestamptz', { name: 'created_at' }) createdAt!: Date;
  @Column('timestamptz', { name: 'activated_at', nullable: true }) activatedAt!: Date | null;
  @Column('timestamptz', { name: 'closed_at', nullable: true }) closedAt!: Date | null;
}

@Entity('observations')
export class ObservationRow {
  @Column('jsonb', { name: 'authenticated_actor', nullable: true })
  authenticatedActor!: AuthenticatedActor | null;
  @PrimaryColumn('uuid') id!: string;
  @Column('uuid', { name: 'order_id', nullable: true }) orderId!: string | null;
  @Column('uuid', { name: 'provisioning_id' }) provisioningId!: string;
  @Column('varchar', { nullable: true }) strategy!: Strategy | null;
  @Column('varchar', { length: 64 }) fingerprint!: string;
  @Column('jsonb') input!: ObservationInput;
  @Column('timestamptz', { name: 'received_at' }) receivedAt!: Date;
}

@Entity('decisions')
export class DecisionRow {
  @PrimaryColumn('uuid', { name: 'observation_id' }) observationId!: string;
  @Column('jsonb') result!: Decision;
}

@Entity('movements')
export class MovementRecord {
  @PrimaryColumn('uuid') id!: string;
  @Column('uuid', { name: 'order_id' }) orderId!: string;
  @Column('uuid', { name: 'provisioning_id' }) provisioningId!: string;
  @Column('uuid', { name: 'observation_id', nullable: true }) observationId!: string | null;
  @Column('varchar') type!: EventType;
  @Column('timestamptz', { name: 'occurred_at' }) occurredAt!: Date;
  @Column('timestamptz', { name: 'received_at' }) receivedAt!: Date;
}

export const traceabilityEntities = [
  OrderRecord,
  TagRecord,
  ProvisioningRecord,
  ObservationRow,
  DecisionRow,
  MovementRecord,
];
