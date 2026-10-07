import { EntityManager } from 'typeorm';
import { DomainError } from '../../shared-kernel/domain-error';
import { Transaction } from '../../bounded-contexts/traceability/application/ports';

/** The order lock is already held. Reading the administrative checkpoint avoids inverse lock ordering. */
export function nfcLifecycleGate(manager: EntityManager): Transaction['administration'] {
  return {
    async assertLifecycle(id, action) {
      const rows: { physical_outcome: string; mutation_issued: boolean }[] = await manager.query(
        `
      SELECT i.physical_outcome,i.mutation_issued FROM nfc_personalization_targets t
      JOIN nfc_inspections i ON i.id=t.operation_id WHERE t.provisioning_id=$1`,
        [id],
      );
      const operation = rows[0];
      if (
        operation &&
        operation.physical_outcome !== 'CONFERIDA' &&
        (action === 'ATIVAR' || operation.mutation_issued)
      )
        throw new DomainError(
          'NFC_PERSONALIZACAO_PENDENTE',
          'Recupere e confira a personalização NFC antes de alterar o vínculo.',
          'conflict',
        );
    },
  };
}
