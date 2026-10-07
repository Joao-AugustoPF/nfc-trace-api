import { DomainError } from '../../../shared-kernel/domain-error';
import { Ev2Channel, Ev2Error } from '../../../platform/nfc/ev2';
import { NodeEv2Cryptography } from '../../../platform/nfc/ev2-crypto';
import { InspectionSnapshot } from '../domain/inspection';
import { MaterialChoice, changeSettingsPayload } from '../domain/personalization-plan';
import {
  CredentialRecord,
  CredentialVault,
  InspectionResult,
  PersonalizationGateway,
} from '../application/ports';
import { Ev2InspectionGateway } from './ev2-inspection-gateway';

interface Frame {
  step: string;
  apduHex: string;
  mutates: boolean;
}
interface LivePersonalization {
  workflow: PersonalizationWorkflow;
  iterator: Generator<Frame, InspectionResult, Uint8Array>;
  expiresAt: number;
}
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex').toUpperCase();
const from = (s: string) => Buffer.from(s, 'hex');
const fail = (code: string, message: string): never => {
  throw new DomainError(code, message, 'conflict');
};

/** Server-owned reversible plan. No credential probing, irreversible configuration or blind resend. */
class PersonalizationWorkflow {
  private channel = new Ev2Channel(new NodeEv2Cryptography());
  private readonly selected = new Uint8Array(80);
  private readonly selectedVersions: number[];
  dataVerified = false;
  private readonly plan;
  constructor(
    private readonly current: Uint8Array,
    private readonly target: Uint8Array,
    private readonly operation: InspectionSnapshot,
    private readonly choices: MaterialChoice[],
    currentVersions: number[],
    private readonly targetVersions: number[],
  ) {
    this.plan = operation.plan.personalization!;
    this.selectedVersions = choices.map((choice, slot) =>
      choice === 'ALVO' ? targetVersions[slot]! : currentVersions[slot]!,
    );
    choices.forEach((choice, slot) =>
      this.selected.set(
        (choice === 'ALVO' ? target : current).subarray(slot * 16, slot * 16 + 16),
        slot * 16,
      ),
    );
  }
  close(): void {
    this.channel.close();
    this.current.fill(0);
    this.target.fill(0);
    this.selected.fill(0);
  }
  private frame(step: string, apdu: Uint8Array, mutates = false): Frame {
    return { step, apduHex: hex(apdu), mutates };
  }
  private *command(
    step: string,
    apdu: Uint8Array,
    mutates = false,
  ): Generator<Frame, Uint8Array, Uint8Array> {
    return this.channel.complete(yield this.frame(step, apdu, mutates)).data;
  }
  private *auth(
    slot: number,
    keys: Uint8Array,
    label: string,
    first = false,
  ): Generator<Frame, void, Uint8Array> {
    if (first) {
      this.channel.close();
      this.channel = new Ev2Channel(new NodeEv2Cryptography());
    }
    const challenge = yield this.frame(
      `${label}_AUTH_${slot}_DESAFIO`,
      this.channel.authenticate(slot, keys.subarray(slot * 16, slot * 16 + 16), !first),
    );
    const confirmation = yield this.frame(
      `${label}_AUTH_${slot}_CONFIRMACAO`,
      this.channel.challenge(challenge),
    );
    this.channel.authenticated(confirmation);
    yield* this.command(
      `${label}_UID_${slot}`,
      this.channel.confirmUid(from(this.operation.plan.uid)),
    );
  }
  private *prove(
    keys: Uint8Array,
    versions: number[],
    label: string,
    first: boolean,
  ): Generator<Frame, void, Uint8Array> {
    yield* this.auth(0, keys, label, first);
    for (let slot = 0; slot < 5; slot++) {
      const value = yield* this.command(`${label}_VERSAO_${slot}`, this.channel.keyVersion(slot));
      if (value[0] !== versions[slot])
        fail('NFC_VERSAO_DIVERGENTE', 'A versão física não corresponde ao material selecionado.');
    }
    for (let slot = 1; slot < 5; slot++) yield* this.auth(slot, keys, label);
    yield* this.auth(0, keys, label);
  }
  private layout(settings: Uint8Array, size: number): void {
    if (
      settings[0] !== 0 ||
      settings.length < 7 ||
      Buffer.from(settings.subarray(4, 7)).readUIntLE(0, 3) !== size ||
      (settings[2]! & 15) !== 0
    )
      fail(
        'NFC_ARQUIVO_INCOMPATIVEL',
        'A tag não possui arquivos e administração compatíveis com este plano.',
      );
  }
  private *read(file: 1 | 2, image: Uint8Array, label: string): Generator<Frame, void, Uint8Array> {
    for (let offset = 0; offset < image.length; offset += 80) {
      const expected = image.subarray(offset, Math.min(offset + 80, image.length));
      const actual = yield* this.command(
        `${label}_${offset}`,
        this.channel.read(file, offset, expected.length, 'FULL'),
      );
      if (!Buffer.from(actual).equals(Buffer.from(expected)))
        fail(
          'NFC_CONTEUDO_DIVERGENTE',
          'A conferência protegida não corresponde ao conteúdo planejado.',
        );
    }
  }
  private *finalSettings(): Generator<Frame, void, Uint8Array> {
    const cc = yield* this.command('CONFERIR_CONFIG_CC', this.channel.settings(1));
    const ndef = yield* this.command('CONFERIR_CONFIG_NDEF', this.channel.settings(2));
    if (hex(cc) !== this.plan.finalCcSettingsHex || hex(ndef) !== this.plan.finalNdefSettingsHex)
      fail('NFC_CONFIGURACAO_DIVERGENTE', 'O perfil final não corresponde ao plano imutável.');
    // CC permits protected access through RW=0. Final NDEF Read=E does not: its proof precedes this profile.
    yield* this.read(1, from(this.plan.ccImageHex), 'CONFERIR_CC_FINAL');
  }
  *run(): Generator<Frame, InspectionResult, Uint8Array> {
    yield* this.prove(this.selected, this.selectedVersions, 'ATUAL', true);
    const cc = yield* this.command('LER_CONFIG_CC', this.channel.settings(1));
    const ndef = yield* this.command('LER_CONFIG_NDEF', this.channel.settings(2));
    this.layout(cc, 32);
    this.layout(ndef, 256);
    const allTarget = this.choices.every((c) => c === 'ALVO');
    const finalSdm = (ndef[1]! & 0x40) !== 0 && hex(ndef) === this.plan.finalNdefSettingsHex;
    if (this.operation.plan.strategy === 'SDM' && finalSdm && allTarget) {
      // Re-enabling SDM resets its counter. Never rewrite an already-installed target epoch.
      if (!this.operation.dataVerified)
        fail(
          'NFC_PROVA_CONTEUDO_AUSENTE',
          'O perfil SDM já está aplicado, mas falta o recibo de conteúdo desta operação.',
        );
      this.dataVerified = true;
      yield* this.finalSettings();
    } else {
      if (
        this.operation.plan.strategy === 'SDM' &&
        finalSdm &&
        this.operation.mutationIssued &&
        this.choices.some((c) => c === 'ALVO')
      )
        fail(
          'NFC_RECUPERACAO_SDM_INCONSISTENTE',
          'Confira os cinco slots; um perfil SDM final não pode ser reconfigurado parcialmente.',
        );
      yield* this.command(
        'ACESSO_PROTEGIDO_CC',
        this.channel.changeSettings(1, from('03F000')),
        true,
      );
      yield* this.command(
        'ACESSO_PROTEGIDO_NDEF',
        this.channel.changeSettings(2, from('03F000')),
        true,
      );
      const oldCc = yield* this.command('LER_CC_ORIGINAL', this.channel.read(1, 0, 23, 'FULL'));
      if (hex(oldCc.subarray(0, 14)) !== '001720010000FF0406E104010000')
        fail('NFC_CC_INCOMPATIVEL', 'O mapeamento NDEF/CC exige inspeção antes da gravação.');
      const ccImage = from(this.plan.ccImageHex),
        image = from(this.plan.ndefImageHex);
      yield* this.command('GRAVAR_CC', this.channel.write(1, 0, ccImage), true);
      yield* this.read(1, ccImage, 'CONFERIR_CC');
      yield* this.command('GRAVAR_NDEF_NLEN_ZERO', this.channel.write(2, 0, from('0000')), true);
      for (let offset = 2; offset < 256; offset += 80)
        yield* this.command(
          `GRAVAR_NDEF_${offset}`,
          this.channel.write(2, offset, image.subarray(offset, Math.min(offset + 80, 256))),
          true,
        );
      const incomplete = Buffer.from(image);
      incomplete[0] = 0;
      incomplete[1] = 0;
      yield* this.read(2, incomplete, 'CONFERIR_NDEF_INCOMPLETO');
      yield* this.command(
        'GRAVAR_NDEF_NLEN_FINAL',
        this.channel.write(2, 0, image.subarray(0, 2)),
        true,
      );
      yield* this.read(2, image, 'CONFERIR_NDEF_FINAL');
      this.dataVerified = true;
      // All selected credentials were authenticated before mutation; master key changes last.
      for (const slot of [1, 2, 3, 4, 0]) {
        const old = this.selected.subarray(slot * 16, slot * 16 + 16),
          next = this.target.subarray(slot * 16, slot * 16 + 16);
        if (
          !Buffer.from(old).equals(Buffer.from(next)) ||
          this.selectedVersions[slot] !== this.targetVersions[slot]
        ) {
          yield* this.command(
            `TROCAR_CHAVE_${slot}`,
            this.channel.changeKey(slot, old, next, this.targetVersions[slot]!),
            true,
          );
        }
      }
      // AuthenticateFirst is required even if key 0 was already target; 9100 alone proves nothing.
      yield* this.prove(this.target, this.targetVersions, 'ALVO', true);
      yield* this.command(
        'APLICAR_CONFIG_CC',
        this.channel.changeSettings(1, from(changeSettingsPayload(this.plan.finalCcSettingsHex))),
        true,
      );
      // Final SDM enablement happens only after byte proof and all five target credentials.
      yield* this.command(
        'APLICAR_CONFIG_NDEF',
        this.channel.changeSettings(2, from(changeSettingsPayload(this.plan.finalNdefSettingsHex))),
        true,
      );
      yield* this.finalSettings();
    }
    return {
      uid: this.operation.plan.uid,
      ndefSettingsHex: this.plan.finalNdefSettingsHex,
      keyVersions: [...this.targetVersions],
      authenticatedSlots: [0, 1, 2, 3, 4],
      personalized: true,
    };
  }
}

export class Ev2AdministrationGateway implements PersonalizationGateway {
  #sessions = new Map<string, LivePersonalization>();
  #timer: ReturnType<typeof setInterval>;
  private readonly inspection: Ev2InspectionGateway;
  constructor(private readonly vault: CredentialVault) {
    this.inspection = new Ev2InspectionGateway(vault);
    this.#timer = setInterval(() => {
      for (const [id, s] of this.#sessions) if (s.expiresAt <= Date.now()) this.close(id);
    }, 5000);
    this.#timer.unref();
  }
  start(id: string, credential: CredentialRecord, expiresAt: string) {
    return this.inspection.start(id, credential, expiresAt);
  }
  startPersonalization(
    id: string,
    current: CredentialRecord,
    target: CredentialRecord,
    operation: InspectionSnapshot,
    choices: MaterialChoice[],
    expiresAt: string,
  ): Frame {
    if (this.has(id)) fail('NFC_SESSAO_EM_USO', 'A sessão RF já está aberta.');
    if (
      choices.length !== 5 ||
      choices.some((c) => !['ATUAL', 'ALVO'].includes(c)) ||
      !operation.plan.personalization
    )
      fail('NFC_MATERIAL_INVALIDO', 'Selecione o material dos cinco slots.');
    const old = this.vault.unseal(current);
    let next: Uint8Array | undefined;
    try {
      next = this.vault.unseal(target);
      const workflow = new PersonalizationWorkflow(
        old,
        next,
        operation,
        choices,
        current.versions,
        target.versions,
      );
      const iterator = workflow.run();
      this.#sessions.set(id, { workflow, iterator, expiresAt: Date.parse(expiresAt) });
      const first = iterator.next();
      if (first.done)
        throw new DomainError(
          'NFC_SEQUENCIA_INVALIDA',
          'O plano não possui autenticação inicial.',
          'conflict',
        );
      return first.value;
    } catch (error) {
      old.fill(0);
      next?.fill(0);
      this.close(id);
      throw error;
    }
  }
  accept(id: string, responseHex: string) {
    const s = this.#sessions.get(id);
    if (!s) return this.inspection.accept(id, responseHex);
    try {
      const next = s.iterator.next(from(responseHex));
      const dataVerified = s.workflow.dataVerified;
      if (next.done) {
        const result = next.value;
        this.close(id);
        return { command: null, result, dataVerified };
      }
      return { command: next.value, result: null, dataVerified };
    } catch (error) {
      this.close(id);
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        error instanceof Ev2Error ? error.code : 'NFC_PERSONALIZACAO_FALHOU',
        'A personalização foi interrompida. Confira o diário e selecione os materiais na recuperação.',
        'conflict',
      );
    }
  }
  has(id: string): boolean {
    const s = this.#sessions.get(id);
    if (s && s.expiresAt <= Date.now()) this.close(id);
    return this.#sessions.has(id) || this.inspection.has(id);
  }
  close(id: string): void {
    this.#sessions.get(id)?.workflow.close();
    this.#sessions.delete(id);
    this.inspection.close(id);
  }
  closeAll(): void {
    clearInterval(this.#timer);
    for (const id of this.#sessions.keys()) this.close(id);
    this.inspection.closeAll();
  }
}
