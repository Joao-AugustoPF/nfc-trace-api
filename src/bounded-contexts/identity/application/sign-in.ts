import { AccessError } from '../../../shared-kernel/actor';
import { accountView, normalizeLogin } from '../domain/account';
import { IdentityClock, IdentityIds, IdentityStore, Passwords, Tokens } from './ports';

export class SignIn {
  constructor(
    private readonly store: IdentityStore,
    private readonly passwords: Passwords,
    private readonly tokens: Tokens,
    private readonly clock: IdentityClock,
    private readonly ids: IdentityIds,
    private readonly sessionSeconds: number,
  ) {}
  async execute(login: string, password: string, address: string, correlationId: string) {
    const normalized = normalizeLogin(login);
    if (!(await this.store.consumeLoginAttempt(normalized, address))) {
      await this.store.audit({
        type: 'LoginNegado',
        actor: null,
        correlationId,
        outcome: 'NEGADO',
        reason: 'LIMITE_LOGIN',
      });
      throw new AccessError(
        'LIMITE_LOGIN',
        'Muitas tentativas. Tente novamente em 15 minutos.',
        'rate-limited',
      );
    }
    const candidate = await this.store.accountByLogin(normalized);
    const valid = await this.passwords.verify(
      password,
      candidate?.passwordHash ?? (await this.passwords.dummyHash()),
    );
    if (!candidate || !valid || !candidate.active) return this.reject(correlationId);
    const token = this.tokens.issue();
    const result = await this.store.run(async (tx) => {
      // Disabling an account and creating a session serialize on the same account row.
      const current = await tx.accounts.get(candidate.id);
      if (!current?.active || current.passwordHash !== candidate.passwordHash) return null;
      const session = {
        id: this.ids.next(),
        userId: current.id,
        tokenHash: this.tokens.digest(token),
        expiresAt: new Date(
          Date.parse(this.clock.now()) + this.sessionSeconds * 1000,
        ).toISOString(),
      };
      await tx.sessions.insert(session);
      await tx.audit({
        type: 'SessaoIniciada',
        actor: { userId: current.id, sessionId: session.id, role: current.role },
        subjectId: current.id,
        correlationId,
        outcome: 'ACEITO',
      });
      return { tokenAcesso: token, expiraEm: session.expiresAt, usuario: accountView(current) };
    });
    return result ?? this.reject(correlationId);
  }
  private async reject(correlationId: string): Promise<never> {
    await this.store.audit({
      type: 'LoginNegado',
      actor: null,
      correlationId,
      outcome: 'NEGADO',
      reason: 'CREDENCIAIS_INVALIDAS',
    });
    throw new AccessError('CREDENCIAIS_INVALIDAS', 'Login ou senha inválidos.', 'unauthenticated');
  }
}
