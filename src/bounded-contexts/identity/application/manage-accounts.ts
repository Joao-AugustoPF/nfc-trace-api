import { AccessError, AuthenticatedActor, Role } from '../../../shared-kernel/actor';
import { DomainError } from '../../../shared-kernel/domain-error';
import { accountView, normalizeLogin, validateAccount } from '../domain/account';
import { IdentityIds, IdentityStore, Passwords } from './ports';

export class ManageAccounts {
  constructor(
    private readonly store: IdentityStore,
    private readonly passwords: Passwords,
    private readonly ids: IdentityIds,
  ) {}
  async create(
    input: { login: string; nome: string; senha: string; perfil: Role },
    actor: AuthenticatedActor | null,
    correlationId: string,
  ) {
    // Null is reserved for the explicit, one-time bootstrap CLI.
    if (actor && actor.role !== 'ADMINISTRADOR')
      throw new AccessError('ACESSO_NEGADO', 'Permissão insuficiente.', 'forbidden');
    const login = normalizeLogin(input.login);
    validateAccount(input);
    const passwordHash = await this.passwords.hash(input.senha);
    return this.store.run(async (tx) => {
      if (!actor) {
        await tx.accounts.lockBootstrap();
        if (await tx.accounts.count())
          throw new DomainError(
            'BOOTSTRAP_CONCLUIDO',
            'Já existem contas. Use um administrador autenticado.',
            'conflict',
          );
        if (input.perfil !== 'ADMINISTRADOR')
          throw new DomainError(
            'PERFIL_BOOTSTRAP_INVALIDO',
            'A primeira conta deve ser administradora.',
            'validation',
          );
      }
      const account = {
        id: this.ids.next(),
        login,
        name: input.nome.trim(),
        role: input.perfil,
        passwordHash,
        active: true,
      };
      await tx.accounts.insert(account);
      await tx.audit({
        type: 'UsuarioCriado',
        actor,
        subjectId: account.id,
        correlationId,
        outcome: 'ACEITO',
      });
      return accountView(account);
    });
  }
  async revoke(userId: string, actor: AuthenticatedActor, correlationId: string, disable = false) {
    if (actor.role !== 'ADMINISTRADOR')
      throw new AccessError('ACESSO_NEGADO', 'Permissão insuficiente.', 'forbidden');
    if (disable && userId === actor.userId)
      throw new DomainError(
        'AUTO_DESATIVACAO',
        'Use outro administrador para desativar sua conta.',
        'conflict',
      );
    return this.store.run(async (tx) => {
      const account = await tx.accounts.get(userId);
      if (!account)
        throw new DomainError('USUARIO_NAO_ENCONTRADO', 'Usuário não encontrado.', 'not-found');
      if (disable) await tx.accounts.disable(userId);
      await tx.sessions.revokeAll(userId);
      await tx.audit({
        type: disable ? 'UsuarioDesativado' : 'SessoesRevogadas',
        actor,
        subjectId: userId,
        correlationId,
        outcome: 'ACEITO',
      });
      return { usuarioId: userId, sessoesRevogadas: true, ativo: disable ? false : account.active };
    });
  }
  async signOut(actor: AuthenticatedActor, correlationId: string) {
    return this.store.run(async (tx) => {
      await tx.sessions.revoke(actor.sessionId, actor.userId);
      await tx.audit({
        type: 'SessaoEncerrada',
        actor,
        subjectId: actor.userId,
        correlationId,
        outcome: 'ACEITO',
      });
      return { encerrada: true };
    });
  }
}
