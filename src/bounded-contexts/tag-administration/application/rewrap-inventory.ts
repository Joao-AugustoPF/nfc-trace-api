import {
  AdministrationClock,
  AdministrationIds,
  AdministrationStore,
  CredentialVault,
} from './ports';

export class RewrapNfcInventory {
  constructor(
    private readonly store: AdministrationStore,
    private readonly vault: CredentialVault,
    private readonly clock: AdministrationClock,
    private readonly ids: AdministrationIds,
  ) {}
  execute(): Promise<number> {
    return this.store.run(async (tx) => {
      const credentials = await tx.credentialsForRewrap();
      for (const record of credentials) {
        const wrapper = this.vault.rewrap(record),
          now = this.clock.now(),
          id = this.ids.next();
        await tx.appendWrapper(id, record.id, wrapper, now);
        await tx.publish({
          id: this.ids.next(),
          type: 'CofreNfcRotacionado',
          version: 1,
          aggregateId: record.id,
          occurredAt: now,
          correlationId: id,
          causationId: null,
          payload: {
            origem: 'CLI_LOCAL',
            referenciaCredenciais: record.id,
            versaoAnterior: record.sealed.masterVersion,
            versaoAtual: wrapper.masterVersion,
          },
        });
      }
      return credentials.length;
    });
  }
}
