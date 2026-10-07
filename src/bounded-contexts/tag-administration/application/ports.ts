import { EventEnvelope } from '../../../shared-kernel/events';
import { AuthenticatedActor } from '../../../shared-kernel/actor';
import { InspectionSnapshot } from '../domain/inspection';

export interface SealedCredentials {
  masterVersion: string;
  nonce: string;
  ciphertext: string;
  authenticationTag: string;
}
export interface CredentialRecord {
  id: string;
  uid: string;
  versions: number[];
  sealed: SealedCredentials;
  createdAt: string;
}
export interface CredentialVault {
  seal(id: string, uid: string, versions: number[], keys: Uint8Array): SealedCredentials;
  unseal(record: CredentialRecord): Uint8Array;
}
export interface ProvisioningGate {
  id: string;
  uid: string;
  model: string;
  epoch: number;
  strategy: string;
  status: string;
}
export interface CommandFrame {
  id: string;
  sequence: number;
  step: string;
  apduHex: string;
}
export interface InspectionResult {
  uid: string;
  ndefSettingsHex: string;
  keyVersions: number[];
  authenticatedSlots: number[];
  personalized: false;
}
export interface SessionReply {
  sessionId: string;
  state: 'EM_ANDAMENTO' | 'CONCLUIDA' | 'INTERROMPIDA';
  expiresAt: string;
  command: CommandFrame | null;
  result: InspectionResult | null;
  errorCode: string | null;
}
export interface SessionRecord {
  id: string;
  operationId: string;
  rfSessionId: string;
  identitySessionId: string;
  fingerprint: string;
  expiresAt: string;
  reply: SessionReply;
}
export interface ResponseRecord {
  commandId: string;
  fingerprint: string;
  reply: SessionReply;
}
export interface JournalEntry {
  id: string;
  operationId: string;
  sessionId: string | null;
  type: 'PREPARADA' | 'INTENCAO' | 'RESPOSTA' | 'INTERROMPIDA' | 'INSPECIONADA' | 'ENCERRADA';
  occurredAt: string;
  details: Record<string, unknown>;
}
export interface AdministrationTransaction {
  authorize(actor: AuthenticatedActor, now: string): Promise<void>;
  lockUid(uid: string): Promise<void>;
  credential(uid: string): Promise<CredentialRecord | null>;
  importCredential(record: CredentialRecord): Promise<void>;
  openByUid(uid: string): Promise<InspectionSnapshot | null>;
  provisioning(id: string): Promise<ProvisioningGate | null>;
  operation(id: string): Promise<InspectionSnapshot | null>;
  saveOperation(snapshot: InspectionSnapshot): Promise<void>;
  session(id: string): Promise<SessionRecord | null>;
  saveSession(record: SessionRecord): Promise<void>;
  response(commandId: string): Promise<ResponseRecord | null>;
  saveResponse(record: ResponseRecord): Promise<void>;
  append(entry: JournalEntry): Promise<void>;
  journal(
    operationId: string,
    page: number,
    limit: number,
  ): Promise<{ items: JournalEntry[]; total: number }>;
  publish(event: EventEnvelope): Promise<void>;
}
export interface AdministrationStore {
  run<T>(work: (tx: AdministrationTransaction) => Promise<T>): Promise<T>;
}
export interface InspectionGateway {
  start(
    id: string,
    credential: CredentialRecord,
    expiresAt: string,
  ): { step: string; apduHex: string };
  accept(
    id: string,
    responseHex: string,
  ): { command: { step: string; apduHex: string } | null; result: InspectionResult | null };
  has(id: string): boolean;
  close(id: string): void;
  closeAll(): void;
}
export interface AdministrationClock {
  now(): string;
}
export interface AdministrationIds {
  next(): string;
}
export interface AdministrationFingerprint {
  of(value: unknown): string;
}
