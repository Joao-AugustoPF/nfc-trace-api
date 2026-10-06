import { CanActivate, createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { Authenticate } from '../../bounded-contexts/identity/application/authenticate';
import { IdentityStore } from '../../bounded-contexts/identity/application/ports';
import { AccessError, AuthenticatedActor, Role } from '../../shared-kernel/actor';

const PUBLIC = 'identity.public';
const ROLES_KEY = 'identity.roles';
export const PublicAccess = () => SetMetadata(PUBLIC, true);
export const AllowRoles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
export interface AuthenticatedRequest extends Request {
  identity: Awaited<ReturnType<Authenticate['execute']>>;
}
export const Principal = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedActor =>
    ctx.switchToHttp().getRequest<AuthenticatedRequest>().identity.actor,
);
export const CurrentSession = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const identity = ctx.switchToHttp().getRequest<AuthenticatedRequest>().identity;
  return { usuario: identity.usuario, expiraEm: identity.expiraEm };
});
export class AuthenticationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authenticate: Authenticate,
    private readonly store: IdentityStore,
  ) {}
  async canActivate(context: ExecutionContext) {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true;
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    let actor: AuthenticatedActor | null = null;
    try {
      const header = request.headers.authorization;
      const token =
        typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
      request.identity = await this.authenticate.execute(token);
      actor = request.identity.actor;
      const roles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, targets) ?? [
        'ADMINISTRADOR',
      ];
      if (!roles.includes(actor.role))
        throw new AccessError(
          'ACESSO_NEGADO',
          'Seu perfil não pode executar esta operação.',
          'forbidden',
        );
      return true;
    } catch (error) {
      if (error instanceof AccessError) {
        await this.store.audit({
          type: 'AcessoNegado',
          actor,
          outcome: 'NEGADO',
          reason: error.code,
          route: request.method + ' ' + String(request.route?.path ?? 'unmatched').slice(0, 150),
          correlationId: String(request.headers['x-correlation-id']),
        });
      }
      throw error;
    }
  }
}
