import { EntityManager } from 'typeorm';
import { AccessError, AuthenticatedActor } from '../../shared-kernel/actor';
// Account/session order matches the identity revocation fence. No ORM types enter application.
export async function experimentAuthorization(
  m: EntityManager,
  actor: AuthenticatedActor,
  admin: boolean,
) {
  const accounts: { active: boolean; role: string }[] = await m.query(
    'SELECT active,role FROM identity_accounts WHERE id=$1 FOR SHARE',
    [actor.userId],
  );
  const sessions: { valid: boolean }[] = await m.query(
    'SELECT revoked_at IS NULL AND expires_at>clock_timestamp() AS valid FROM identity_sessions WHERE id=$1 AND user_id=$2 FOR SHARE',
    [actor.sessionId, actor.userId],
  );
  if (
    !accounts[0]?.active ||
    !sessions[0]?.valid ||
    (admin
      ? accounts[0].role !== 'ADMINISTRADOR'
      : !['ADMINISTRADOR', 'OPERADOR'].includes(accounts[0].role))
  )
    throw new AccessError(
      'ACESSO_NEGADO',
      'A permissão foi revogada ou a sessão expirou.',
      'forbidden',
    );
}
