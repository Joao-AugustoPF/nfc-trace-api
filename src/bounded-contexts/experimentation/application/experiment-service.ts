import { AccessError, AuthenticatedActor } from '../../../shared-kernel/actor';
import { DomainError } from '../../../shared-kernel/domain-error';
import { ClientRecordInput, GroundTruthInput, RunInput, TrialInput } from '../domain/types';
import { assertClientRecord, assertGroundTruth, assertTrial } from '../domain/rules';
import { ExperimentFingerprint, ExperimentStore } from './ports';
import { validateDataset, summarizeDataset, datasetMetrics } from '../domain/dataset';

const required = <T>(item: T | null): T => {
  if (!item)
    throw new DomainError(
      'EXPERIMENTO_NAO_ENCONTRADO',
      'Execução ou tentativa não encontrada.',
      'not-found',
    );
  return item;
};
function role(actor: AuthenticatedActor, admin: boolean) {
  if (admin ? actor.role !== 'ADMINISTRADOR' : actor.role === 'CONSULTA')
    throw new AccessError('ACESSO_NEGADO', 'Permissão insuficiente.', 'forbidden');
}
export class ExperimentService {
  constructor(
    private readonly store: ExperimentStore,
    private readonly fingerprints: ExperimentFingerprint,
  ) {}
  async createRun(input: RunInput, actor: AuthenticatedActor) {
    role(actor, true);
    return this.store.write(async (tx) => {
      await tx.authorize(actor, true);
      await tx.lock(input.id);
      const old = await tx.run(input.id);
      if (old) {
        if (this.fingerprints.of(old.input) !== this.fingerprints.of(input))
          throw new DomainError(
            'EXPERIMENTO_CONFLITANTE',
            'UUID utilizado com outro conteúdo.',
            'conflict',
          );
        return old;
      }
      return tx.insertRun(input, this.fingerprints.of(input), actor);
    });
  }
  async createTrial(input: TrialInput, actor: AuthenticatedActor) {
    role(actor, true);
    return this.store.write(async (tx) => {
      await tx.authorize(actor, true);
      await tx.lock(input.id);
      const old = await tx.trial(input.id);
      if (old) {
        if (this.fingerprints.of(old.input) !== this.fingerprints.of(input))
          throw new DomainError(
            'EXPERIMENTO_CONFLITANTE',
            'UUID utilizado com outro conteúdo.',
            'conflict',
          );
        return old;
      }
      const run = required(await tx.run(input.runId));
      const p = await tx.provisioning(input.provisioningId);
      if (!p)
        throw new DomainError(
          'VINCULO_NAO_ENCONTRADO',
          'Cadastre o vínculo planejado antes da tentativa.',
          'not-found',
        );
      assertTrial(run.input, input, p);
      return tx.insertTrial(input, this.fingerprints.of(input), actor);
    });
  }
  async groundTruth(input: GroundTruthInput, actor: AuthenticatedActor) {
    role(actor, true);
    return this.store.write(async (tx) => {
      await tx.authorize(actor, true);
      await tx.lock(input.trialId);
      await tx.lock(input.id);
      const old = await tx.truth(input.id);
      if (old) {
        if (old.fingerprint !== this.fingerprints.of(input) || old.userId !== actor.userId)
          throw new DomainError(
            'EXPERIMENTO_CONFLITANTE',
            'O registro original foi preservado.',
            'conflict',
          );
        return {
          input: old.input,
          recordedAt: old.recordedAt,
          userId: old.userId,
          revision: old.revision,
        };
      }
      const trial = required(await tx.trial(input.trialId));
      assertGroundTruth(required(await tx.run(trial.input.runId)).input, input);
      return tx.insertTruth(input, this.fingerprints.of(input), actor);
    });
  }
  async record(input: ClientRecordInput, actor: AuthenticatedActor) {
    role(actor, false);
    return this.store.write(async (tx) => {
      await tx.authorize(actor, false);
      await tx.lock(input.id);
      const old = await tx.client(input.id);
      if (old) {
        if (old.fingerprint !== this.fingerprints.of(input) || old.userId !== actor.userId)
          throw new DomainError(
            'EXPERIMENTO_CONFLITANTE',
            'O registro original foi preservado.',
            'conflict',
          );
        return { input: old.input, recordedAt: old.recordedAt, userId: old.userId };
      }
      const trial = required(await tx.trial(input.trialId));
      assertClientRecord(trial.input, input);
      return tx.insertClient(input, this.fingerprints.of(input), actor);
    });
  }
  runs(page: number, limit: number) {
    return this.store.runs(page, limit);
  }
  trials(id: string, page: number, limit: number) {
    return this.store.trials(id, page, limit);
  }
  async export(id: string, actor: AuthenticatedActor) {
    role(actor, true);
    const dataset = required(await this.store.export(id));
    return {
      schemaVersion: 1,
      checksum: this.fingerprints.of(dataset),
      dataset,
      integrity: validateDataset(dataset),
      summary: summarizeDataset(dataset),
      metrics: datasetMetrics(dataset),
    };
  }
}
