import { AccessError, AuthenticatedActor } from '../../../shared-kernel/actor';
import { DomainError } from '../../../shared-kernel/domain-error';
import { Inspection, InspectionSnapshot, validateInventory } from '../domain/inspection';
import {
  AdministrationClock,
  AdministrationFingerprint,
  AdministrationIds,
  AdministrationStore,
  AdministrationTransaction,
  CredentialVault,
  InspectionGateway,
  JournalEntry,
  SessionRecord,
  SessionReply,
} from './ports';

export class ImportNfcInventory {
  constructor(
    private readonly store: AdministrationStore,
    private readonly vault: CredentialVault,
    private readonly clock: AdministrationClock,
    private readonly ids: AdministrationIds,
  ) {}
  async execute(uid: string, versions: number[], keys: Uint8Array): Promise<{ reference: string }> {
    validateInventory(uid, versions);
    if (keys.length !== 80)
      throw new DomainError('NFC_INVENTARIO_INVALIDO', 'Informe os cinco slots AES.');
    return this.store.run(async (tx) => {
      await tx.lockUid(uid);
      if (await tx.openByUid(uid))
        throw new DomainError(
          'NFC_INVENTARIO_EM_USO',
          'Encerre a inspeção pendente antes de substituir o inventário.',
          'conflict',
        );
      const id = this.ids.next(),
        now = this.clock.now();
      const sealed = this.vault.seal(id, uid, versions, keys);
      await tx.importCredential({ id, uid, versions: [...versions], sealed, createdAt: now });
      const eventId = this.ids.next();
      await tx.publish({
        id: eventId,
        type: 'InventarioNfcDeclarado',
        version: 1,
        aggregateId: id,
        occurredAt: now,
        correlationId: eventId,
        causationId: null,
        payload: {
          origem: 'CLI_LOCAL',
          uid,
          referenciaCredenciais: id,
          versoes: versions,
          autenticadoFisicamente: false,
        },
      });
      return { reference: id };
    });
  }
}

export interface BeginInspection {
  id: string;
  provisioningId: string;
  station: string;
}
export interface BeginRfSession {
  id: string;
  rfSessionId: string;
  station: string;
  recovery: boolean;
}
export interface SubmitRfResponse {
  commandId: string;
  rfSessionId: string;
  station: string;
  responseHex: string;
}

export class NfcAdministration {
  constructor(
    private readonly store: AdministrationStore,
    private readonly gateway: InspectionGateway,
    private readonly clock: AdministrationClock,
    private readonly ids: AdministrationIds,
    private readonly fingerprint: AdministrationFingerprint,
    private readonly leaseSeconds = 180,
  ) {}
  private admin(actor: AuthenticatedActor): void {
    if (actor.role !== 'ADMINISTRADOR')
      throw new AccessError(
        'ACESSO_NEGADO',
        'A administração NFC exige perfil administrador.',
        'forbidden',
      );
  }
  private owner(op: InspectionSnapshot, actor: AuthenticatedActor, station: string): void {
    this.admin(actor);
    if (op.actorId !== actor.userId || op.station !== station)
      throw new AccessError(
        'NFC_ESTACAO_DIVERGENTE',
        'Use a conta e a estação que prepararam esta operação.',
        'forbidden',
      );
  }
  private async load(tx: AdministrationTransaction, id: string): Promise<Inspection> {
    const op = await tx.operation(id);
    if (!op)
      throw new DomainError('NFC_INSPECAO_INEXISTENTE', 'Inspeção não encontrada.', 'not-found');
    return Inspection.restore(op);
  }
  private async log(
    tx: AdministrationTransaction,
    op: Inspection,
    type: JournalEntry['type'],
    sessionId: string | null,
    details: Record<string, unknown>,
    id = this.ids.next(),
  ): Promise<void> {
    const snapshot = op.snapshot();
    const now = this.clock.now();
    await tx.append({ id, operationId: snapshot.id, sessionId, type, occurredAt: now, details });
    const eventId = this.ids.next();
    await tx.publish({
      id: eventId,
      type: `AdministracaoNfc${type}`,
      version: 1,
      aggregateId: snapshot.id,
      occurredAt: now,
      correlationId: snapshot.id,
      causationId: id,
      payload: {
        operacaoId: snapshot.id,
        provisionamentoId: snapshot.plan.provisioningId,
        administradorId: snapshot.actorId,
        estacao: snapshot.station,
        sessaoId: sessionId,
        ...details,
      },
    });
  }
  private async stop(
    tx: AdministrationTransaction,
    op: Inspection,
    session: SessionRecord,
    code: string,
  ): Promise<void> {
    this.gateway.close(session.id);
    op.interrupt();
    session.reply = {
      ...session.reply,
      state: 'INTERROMPIDA',
      command: null,
      result: null,
      errorCode: code,
    };
    await tx.saveSession(session);
    await tx.saveOperation(op.snapshot());
    await this.log(tx, op, 'INTERROMPIDA', session.id, {
      codigo: code,
      alteracaoFisica: false,
      novaSessaoRfObrigatoria: true,
    });
  }
  private async refresh(tx: AdministrationTransaction, op: Inspection): Promise<void> {
    const id = op.snapshot().activeSession;
    if (!id) return;
    const session = (await tx.session(id))!;
    const link = await tx.provisioning(op.snapshot().plan.provisioningId);
    if (!link || link.status !== 'REGISTRADA') {
      await this.stop(tx, op, session, 'NFC_VINCULO_NAO_PENDENTE');
      return;
    }
    if (Date.parse(session.expiresAt) <= Date.parse(this.clock.now()) || !this.gateway.has(id))
      await this.stop(
        tx,
        op,
        session,
        Date.parse(session.expiresAt) <= Date.parse(this.clock.now())
          ? 'NFC_SESSAO_EXPIRADA'
          : 'NFC_SESSAO_PERDIDA',
      );
  }
  async prepare(input: BeginInspection, actor: AuthenticatedActor): Promise<InspectionSnapshot> {
    this.admin(actor);
    return this.store.run(async (tx) => {
      await tx.authorize(actor, this.clock.now());
      const existing = await tx.operation(input.id);
      if (existing) {
        if (
          existing.plan.provisioningId !== input.provisioningId ||
          existing.actorId !== actor.userId ||
          existing.station !== input.station
        )
          throw new DomainError(
            'NFC_IDEMPOTENCIA_CONFLITO',
            'O identificador já está associado a outra inspeção.',
            'conflict',
          );
        return existing;
      }
      const link = await tx.provisioning(input.provisioningId);
      if (!link)
        throw new DomainError(
          'PROVISIONAMENTO_INEXISTENTE',
          'Provisionamento não encontrado.',
          'not-found',
        );
      if (link.status !== 'REGISTRADA')
        throw new DomainError(
          'NFC_VINCULO_NAO_PENDENTE',
          'A administração física exige vínculo registrado e ainda não ativo.',
          'conflict',
        );
      if (link.model.replace(/[^a-zA-Z0-9]/g, '').toUpperCase() !== 'NTAG424DNA')
        throw new DomainError(
          'NFC_MODELO_INCOMPATIVEL',
          'Este protocolo exige NTAG 424 DNA.',
          'unsupported',
        );
      await tx.lockUid(link.uid);
      if (await tx.openByUid(link.uid))
        throw new DomainError(
          'NFC_ETIQUETA_EM_USO',
          'Encerre a inspeção anterior desta etiqueta.',
          'conflict',
        );
      const credentials = await tx.credential(link.uid);
      if (!credentials)
        throw new DomainError(
          'NFC_INVENTARIO_AUSENTE',
          'Importe o inventário privado desta etiqueta pela CLI local.',
          'conflict',
        );
      validateInventory(link.uid, credentials.versions);
      const plan = {
        version: 1 as const,
        purpose: 'INSPECAO_EV2' as const,
        provisioningId: link.id,
        uid: link.uid,
        epoch: link.epoch,
        strategy: link.strategy,
        credentialReference: credentials.id,
        keyVersions: [...credentials.versions],
      };
      const op = Inspection.prepare({
        id: input.id,
        plan,
        planHash: this.fingerprint.of(plan),
        actorId: actor.userId,
        station: input.station,
        createdAt: this.clock.now(),
      });
      await tx.saveOperation(op.snapshot());
      await this.log(tx, op, 'PREPARADA', null, {
        hashPlano: op.snapshot().planHash,
        finalidade: plan.purpose,
        referenciaCredenciais: credentials.id,
      });
      return op.snapshot();
    });
  }
  async get(id: string, actor: AuthenticatedActor): Promise<InspectionSnapshot> {
    this.admin(actor);
    return this.store.run(async (tx) => {
      await tx.authorize(actor, this.clock.now());
      const op = await this.load(tx, id);
      await this.refresh(tx, op);
      return op.snapshot();
    });
  }
  async journal(id: string, page: number, limit: number, actor: AuthenticatedActor) {
    this.admin(actor);
    return this.store.run(async (tx) => {
      await tx.authorize(actor, this.clock.now());
      await this.load(tx, id);
      return tx.journal(id, page, limit);
    });
  }
  private async intent(
    tx: AdministrationTransaction,
    op: Inspection,
    session: SessionRecord,
    frame: { step: string; apduHex: string },
    sequence: number,
  ): Promise<void> {
    const id = this.ids.next();
    session.reply.command = { ...frame, id, sequence };
    // Persist command identity/digest before returning its APDU. Never persist private key material.
    await tx.saveSession(session);
    await this.log(
      tx,
      op,
      'INTENCAO',
      session.id,
      {
        comandoId: id,
        sequencia: sequence,
        etapa: frame.step,
        hashComando: this.fingerprint.of(frame.apduHex),
        alteraTag: false,
      },
      id,
    );
  }
  async begin(id: string, input: BeginRfSession, actor: AuthenticatedActor): Promise<SessionReply> {
    let allocated = false;
    try {
      return await this.store.run(async (tx) => {
        await tx.authorize(actor, this.clock.now());
        const op = await this.load(tx, id);
        this.owner(op.snapshot(), actor, input.station);
        const digest = this.fingerprint.of({
          ...input,
          operationId: id,
          identitySessionId: actor.sessionId,
        });
        const existing = await tx.session(input.id);
        if (existing) {
          if (existing.fingerprint !== digest)
            throw new DomainError(
              'NFC_IDEMPOTENCIA_CONFLITO',
              'A sessão possui conteúdo diferente.',
              'conflict',
            );
          await this.refresh(tx, op);
          return (await tx.session(input.id))!.reply;
        }
        await this.refresh(tx, op);
        const link = await tx.provisioning(op.snapshot().plan.provisioningId);
        if (!link || link.status !== 'REGISTRADA')
          throw new DomainError(
            'NFC_VINCULO_NAO_PENDENTE',
            'O vínculo não permite nova sessão administrativa.',
            'conflict',
          );
        const credential = await tx.credential(op.snapshot().plan.uid);
        if (!credential || credential.id !== op.snapshot().plan.credentialReference)
          throw new DomainError(
            'NFC_INVENTARIO_DIVERGENTE',
            'O inventário mudou; prepare outra operação.',
            'conflict',
          );
        op.begin(input.id, input.recovery);
        const expiresAt = new Date(
          Date.parse(this.clock.now()) + this.leaseSeconds * 1000,
        ).toISOString();
        const session: SessionRecord = {
          id: input.id,
          operationId: id,
          rfSessionId: input.rfSessionId,
          identitySessionId: actor.sessionId,
          fingerprint: digest,
          expiresAt,
          reply: {
            sessionId: input.id,
            state: 'EM_ANDAMENTO',
            expiresAt,
            command: null,
            result: null,
            errorCode: null,
          },
        };
        const frame = this.gateway.start(input.id, credential, expiresAt);
        allocated = true;
        await tx.saveOperation(op.snapshot());
        await this.intent(tx, op, session, frame, 1);
        return session.reply;
      });
    } catch (error) {
      if (allocated) this.gateway.close(input.id);
      throw error;
    }
  }
  async respond(
    id: string,
    sessionId: string,
    input: SubmitRfResponse,
    actor: AuthenticatedActor,
  ): Promise<SessionReply> {
    let touched = false;
    try {
      return await this.store.run(async (tx) => {
        await tx.authorize(actor, this.clock.now());
        const op = await this.load(tx, id);
        this.owner(op.snapshot(), actor, input.station);
        const session = await tx.session(sessionId);
        if (!session || session.operationId !== id)
          throw new DomainError('NFC_SESSAO_INEXISTENTE', 'Sessão não encontrada.', 'not-found');
        if (
          session.identitySessionId !== actor.sessionId ||
          session.rfSessionId !== input.rfSessionId
        )
          throw new AccessError(
            'NFC_SESSAO_DIVERGENTE',
            'Use a sessão autenticada e a sessão RF originais.',
            'forbidden',
          );
        const digest = this.fingerprint.of(input.responseHex.toUpperCase());
        const cached = await tx.response(input.commandId);
        if (cached && (cached.fingerprint !== digest || cached.reply.sessionId !== sessionId))
          throw new DomainError(
            'NFC_IDEMPOTENCIA_CONFLITO',
            'Este comando já tem outra resposta.',
            'conflict',
          );
        await this.refresh(tx, op);
        if (!op.snapshot().activeSession) return (await tx.session(sessionId))!.reply;
        if (op.snapshot().activeSession !== sessionId)
          throw new DomainError(
            'NFC_SESSAO_SUPERADA',
            'Existe outra sessão RF em andamento.',
            'conflict',
          );
        const link = await tx.provisioning(op.snapshot().plan.provisioningId);
        if (!link || link.status !== 'REGISTRADA') {
          await this.stop(tx, op, session, 'NFC_VINCULO_NAO_PENDENTE');
          return session.reply;
        }
        // A replay returns the current checkpoint, never an obsolete APDU.
        if (cached) return session.reply;
        if (session.reply.command?.id !== input.commandId)
          throw new DomainError(
            'NFC_COMANDO_DIVERGENTE',
            'Envie a resposta do comando pendente.',
            'conflict',
          );
        const previous = session.reply.command;
        touched = true;
        try {
          const next = this.gateway.accept(sessionId, input.responseHex);
          if (next.command) await this.intent(tx, op, session, next.command, previous.sequence + 1);
          else {
            op.complete();
            session.reply = {
              ...session.reply,
              state: 'CONCLUIDA',
              command: null,
              result: next.result,
              errorCode: null,
            };
            await tx.saveSession(session);
            await tx.saveOperation(op.snapshot());
            await this.log(tx, op, 'INSPECIONADA', sessionId, {
              slotsAutenticados: next.result!.authenticatedSlots,
              personalizada: false,
            });
          }
        } catch (error) {
          if (!(error instanceof DomainError)) throw error;
          await this.stop(tx, op, session, error.code);
        }
        await tx.saveResponse({
          commandId: input.commandId,
          fingerprint: digest,
          reply: structuredClone(session.reply),
        });
        await this.log(tx, op, 'RESPOSTA', sessionId, {
          comandoId: input.commandId,
          etapa: previous.step,
          hashResposta: digest,
          resultado: session.reply.state,
          codigo: session.reply.errorCode,
        });
        return session.reply;
      });
    } catch (error) {
      if (touched) this.gateway.close(sessionId);
      throw error;
    }
  }
  async end(id: string, station: string, actor: AuthenticatedActor): Promise<InspectionSnapshot> {
    return this.store.run(async (tx) => {
      await tx.authorize(actor, this.clock.now());
      const op = await this.load(tx, id);
      this.owner(op.snapshot(), actor, station);
      if (op.snapshot().state === 'ENCERRADA') return op.snapshot();
      const active = op.snapshot().activeSession;
      if (active) await this.stop(tx, op, (await tx.session(active))!, 'NFC_CANCELADA');
      op.end();
      await tx.saveOperation(op.snapshot());
      await this.log(tx, op, 'ENCERRADA', null, {});
      return op.snapshot();
    });
  }
  async interrupt(
    id: string,
    sessionId: string,
    rfSessionId: string,
    station: string,
    actor: AuthenticatedActor,
  ): Promise<SessionReply> {
    return this.store.run(async (tx) => {
      await tx.authorize(actor, this.clock.now());
      const op = await this.load(tx, id);
      this.owner(op.snapshot(), actor, station);
      const session = await tx.session(sessionId);
      if (!session || session.operationId !== id)
        throw new DomainError('NFC_SESSAO_INEXISTENTE', 'Sessão não encontrada.', 'not-found');
      if (session.rfSessionId !== rfSessionId)
        throw new AccessError(
          'NFC_SESSAO_DIVERGENTE',
          'Informe a sessão RF que será interrompida.',
          'forbidden',
        );
      if (op.snapshot().activeSession === sessionId)
        await this.stop(tx, op, session, 'NFC_CANCELADA');
      // The owning account may interrupt its old identity session after signing in again.
      // It still cannot submit APDU responses under that old session.
      return session.reply;
    });
  }
}
