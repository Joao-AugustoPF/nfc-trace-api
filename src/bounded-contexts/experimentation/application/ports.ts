import { AuthenticatedActor } from '../../../shared-kernel/actor';
import {
  ClientRecordInput,
  Dataset,
  GroundTruthInput,
  GroundTruthRecord,
  RunInput,
  Stored,
  TrialInput,
} from '../domain/types';

export interface ExperimentTransaction {
  authorize(actor: AuthenticatedActor, admin: boolean): Promise<void>;
  run(id: string): Promise<Stored<RunInput> | null>;
  trial(id: string): Promise<Stored<TrialInput> | null>;
  client(id: string): Promise<(Stored<ClientRecordInput> & { fingerprint: string }) | null>;
  truth(id: string): Promise<(GroundTruthRecord & { fingerprint: string }) | null>;
  provisioning(id: string): Promise<{ strategy: string; policy: string | null } | null>;
  insertRun(
    input: RunInput,
    fingerprint: string,
    actor: AuthenticatedActor,
  ): Promise<Stored<RunInput>>;
  insertTrial(
    input: TrialInput,
    fingerprint: string,
    actor: AuthenticatedActor,
  ): Promise<Stored<TrialInput>>;
  insertTruth(
    input: GroundTruthInput,
    fingerprint: string,
    actor: AuthenticatedActor,
  ): Promise<GroundTruthRecord>;
  insertClient(
    input: ClientRecordInput,
    fingerprint: string,
    actor: AuthenticatedActor,
  ): Promise<Stored<ClientRecordInput>>;
  lock(id: string): Promise<void>;
}
export interface ExperimentStore {
  write<T>(work: (tx: ExperimentTransaction) => Promise<T>): Promise<T>;
  runs(page: number, limit: number): Promise<{ items: Stored<RunInput>[]; total: number }>;
  trials(
    runId: string,
    page: number,
    limit: number,
  ): Promise<{ items: Stored<TrialInput>[]; total: number }>;
  export(runId: string): Promise<Dataset | null>;
}
export interface ExperimentFingerprint {
  of(value: unknown): string;
}
