import {
  CredentialRecord,
  CredentialVault,
  InspectionGateway,
  InspectionResult,
} from '../application/ports';
import { DomainError } from '../../../shared-kernel/domain-error';
import { Ev2Channel, Ev2Error } from '../../../platform/nfc/ev2';
import { NodeEv2Cryptography } from '../../../platform/nfc/ev2-crypto';

interface LiveSession {
  channel: Ev2Channel;
  keys: Uint8Array;
  uid: string;
  versions: number[];
  step: string;
  slot: number;
  keyVersion: number;
  expiresAt: number;
  result: InspectionResult;
}
/** Read-only sequence chosen by the server. No HTTP-supplied instructions or keys. */
export class Ev2InspectionGateway implements InspectionGateway {
  #sessions = new Map<string, LiveSession>();
  #timer: ReturnType<typeof setInterval>;
  constructor(private readonly vault: CredentialVault) {
    this.#timer = setInterval(() => {
      for (const [id, s] of this.#sessions) if (s.expiresAt <= Date.now()) this.close(id);
    }, 5000);
    this.#timer.unref();
  }
  has(id: string): boolean {
    const s = this.#sessions.get(id);
    if (s && s.expiresAt <= Date.now()) this.close(id);
    return this.#sessions.has(id);
  }
  close(id: string): void {
    const session = this.#sessions.get(id);
    if (session) {
      session.channel.close();
      session.keys.fill(0);
      this.#sessions.delete(id);
    }
  }
  closeAll(): void {
    clearInterval(this.#timer);
    for (const id of this.#sessions.keys()) this.close(id);
  }
  start(id: string, record: CredentialRecord, expiresAt: string) {
    if (this.has(id))
      throw new DomainError('NFC_SESSAO_EM_USO', 'Esta sessão RF já está aberta.', 'conflict');
    const keys = this.vault.unseal(record);
    const channel = new Ev2Channel(new NodeEv2Cryptography());
    const session: LiveSession = {
      channel,
      keys,
      uid: record.uid,
      versions: record.versions,
      step: 'AUTH_0_DESAFIO',
      slot: 0,
      keyVersion: 0,
      expiresAt: Date.parse(expiresAt),
      result: {
        uid: record.uid,
        ndefSettingsHex: '',
        keyVersions: [],
        authenticatedSlots: [],
        personalized: false,
      },
    };
    this.#sessions.set(id, session);
    try {
      return {
        step: session.step,
        apduHex: Buffer.from(channel.authenticate(0, keys.subarray(0, 16)))
          .toString('hex')
          .toUpperCase(),
      };
    } catch (error) {
      this.close(id);
      throw error;
    }
  }
  accept(id: string, responseHex: string) {
    const s = this.#sessions.get(id);
    if (!s)
      throw new DomainError(
        'NFC_SESSAO_PERDIDA',
        'Abra outra sessão RF para recuperar a inspeção.',
        'conflict',
      );
    try {
      const raw = Buffer.from(responseHex, 'hex');
      let command: Uint8Array;
      if (s.step.endsWith('_DESAFIO')) {
        command = s.channel.challenge(raw);
        s.step = `AUTH_${s.slot}_CONFIRMACAO`;
      } else if (s.step.endsWith('_CONFIRMACAO')) {
        s.channel.authenticated(raw);
        command = s.channel.confirmUid(Buffer.from(s.uid, 'hex'));
        s.step = `UID_${s.slot}`;
      } else {
        const receipt = s.channel.complete(raw);
        if (s.step.startsWith('UID_')) {
          s.result.authenticatedSlots.push(s.slot);
          if (s.slot === 0) {
            command = s.channel.settings();
            s.step = 'CONFIG_NDEF';
          } else if (s.slot === 4) {
            const result = structuredClone(s.result);
            this.close(id);
            return { command: null, result };
          } else {
            s.slot++;
            command = s.channel.authenticate(
              s.slot,
              s.keys.subarray(s.slot * 16, s.slot * 16 + 16),
              true,
            );
            s.step = `AUTH_${s.slot}_DESAFIO`;
          }
        } else if (s.step === 'CONFIG_NDEF') {
          // Standard data file, expected 256-byte NDEF file; do not write unknown layouts.
          if (
            receipt.data[0] !== 0 ||
            Buffer.from(receipt.data.subarray(4, 7)).readUIntLE(0, 3) !== 256
          )
            throw new DomainError(
              'NFC_ARQUIVO_INCOMPATIVEL',
              'O arquivo NDEF não corresponde ao modelo esperado.',
              'conflict',
            );
          s.result.ndefSettingsHex = Buffer.from(receipt.data).toString('hex').toUpperCase();
          command = s.channel.keyVersion(0);
          s.step = 'VERSAO_0';
        } else {
          const version = receipt.data[0]!;
          if (version !== s.versions[s.keyVersion])
            throw new DomainError(
              'NFC_VERSAO_DIVERGENTE',
              'A versão física diverge do inventário declarado; revise as credenciais localmente.',
              'conflict',
            );
          s.result.keyVersions.push(version);
          if (s.keyVersion < 4) {
            s.keyVersion++;
            command = s.channel.keyVersion(s.keyVersion);
            s.step = `VERSAO_${s.keyVersion}`;
          } else {
            s.slot = 1;
            command = s.channel.authenticate(1, s.keys.subarray(16, 32), true);
            s.step = 'AUTH_1_DESAFIO';
          }
        }
      }
      return {
        command: { step: s.step, apduHex: Buffer.from(command).toString('hex').toUpperCase() },
        result: null,
      };
    } catch (error) {
      this.close(id);
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        error instanceof Ev2Error ? error.code : 'NFC_INSPECAO_FALHOU',
        'A inspeção foi interrompida. Confira o diário e abra outra sessão RF.',
        'conflict',
      );
    }
  }
}
