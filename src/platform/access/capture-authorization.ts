import { EntityManager } from 'typeorm';
import { CaptureAuthorization } from '../../bounded-contexts/traceability/application/ports';

// Composition bridge: business code knows only the permission port, never identity tables.
// Account then session locks also fence concurrent revocation until this effect commits.
export const captureAuthorization = (manager: EntityManager): CaptureAuthorization => ({
  async check(actor, now) {
    if (!actor || !['OPERADOR', 'ADMINISTRADOR'].includes(actor.role))
      return { allowed: false, reason: 'IDENTIDADE_NAO_VERIFICADA', expiresAt: null };
    const accounts: { active: boolean; role: string }[] = await manager.query(
      'SELECT active,role FROM identity_accounts WHERE id=$1 FOR SHARE',
      [actor.userId],
    );
    const sessions: { expires_at: Date; revoked_at: Date | null }[] = await manager.query(
      'SELECT expires_at,revoked_at FROM identity_sessions WHERE id=$1 AND user_id=$2 FOR SHARE',
      [actor.sessionId, actor.userId],
    );
    const a = accounts[0];
    const s = sessions[0];
    if (!a?.active || !['OPERADOR', 'ADMINISTRADOR'].includes(a.role) || !s || s.revoked_at)
      return { allowed: false, reason: 'PERMISSAO_REVOGADA', expiresAt: null };
    const expiresAt = s.expires_at.toISOString();
    return {
      allowed: expiresAt > now,
      reason: expiresAt > now ? 'PERMITIDA' : 'SESSAO_EXPIRADA',
      expiresAt,
    };
  },
});
