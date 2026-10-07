import { randomBytes } from 'node:crypto';
import {
  CredentialRecord,
  CredentialVault,
  ProvisioningGate,
  SdmTarget,
  TargetGenerator,
} from '../application/ports';
import { DomainError } from '../../../shared-kernel/domain-error';

export class NodeTargetGenerator implements TargetGenerator {
  constructor(
    private readonly vault: CredentialVault,
    private readonly sdmKeys: (id: string, target: SdmTarget) => Uint8Array,
  ) {}
  generate(
    id: string,
    current: CredentialRecord,
    provisioning: ProvisioningGate,
    now: string,
  ): CredentialRecord {
    const keys = randomBytes(80),
      versions = current.versions.map((v) => (v + 1) % 256);
    try {
      if (provisioning.strategy === 'SDM') {
        if (!provisioning.sdm)
          throw new DomainError(
            'SDM_CHAVES_INDISPONIVEIS',
            'O vínculo não possui material SDM.',
            'unavailable',
          );
        const sdm = this.sdmKeys(provisioning.id, provisioning.sdm);
        try {
          if (sdm.length !== 32)
            throw new DomainError(
              'SDM_CHAVES_INDISPONIVEIS',
              'Material SDM incompatível.',
              'unavailable',
            );
          keys.set(sdm, 16);
          versions[1] = versions[2] = provisioning.sdm.keyVersion;
        } finally {
          sdm.fill(0);
        }
      }
      return {
        id,
        uid: current.uid,
        versions,
        sealed: this.vault.seal(id, current.uid, versions, keys),
        createdAt: now,
      };
    } finally {
      keys.fill(0);
    }
  }
}
