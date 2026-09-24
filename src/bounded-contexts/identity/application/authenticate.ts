import { AccessError, AuthenticatedActor } from '../../../shared-kernel/actor';
import { accountView } from '../domain/account';
import { IdentityStore, Tokens } from './ports';

export class Authenticate {
  constructor(
    private readonly store: IdentityStore,
    private readonly tokens: Tokens,
  ) {}
  async execute(token: string) {
    if (!/^nfc_[A-Za-z0-9_-]{43}$/.test(token)) throw this.invalid();
    const result = await this.store.session(this.tokens.digest(token));
    if (!result) throw this.invalid();
    const actor: AuthenticatedActor = {
      userId: result.account.id,
      sessionId: result.session.id,
      role: result.account.role,
    };
    return { actor, usuario: accountView(result.account), expiraEm: result.session.expiresAt };
  }
  private invalid() {
    return new AccessError(
      'SESSAO_INVALIDA',
      'Sessão ausente, expirada ou revogada. Entre novamente.',
      'unauthenticated',
    );
  }
}
