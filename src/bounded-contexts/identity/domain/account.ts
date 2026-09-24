import { Role, ROLES } from '../../../shared-kernel/actor';
import { DomainError } from '../../../shared-kernel/domain-error';

export interface Account {
  id: string;
  login: string;
  name: string;
  role: Role;
  passwordHash: string;
  active: boolean;
}
export function normalizeLogin(login: string): string {
  const value = login.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(value))
    throw new DomainError('LOGIN_INVALIDO', 'Use de 3 a 64 caracteres no login.', 'validation');
  return value;
}
export function validateAccount(input: { nome: string; senha: string; perfil: Role }): void {
  if (!input.nome.trim() || input.nome.trim().length > 100 || !ROLES.includes(input.perfil))
    throw new DomainError('USUARIO_INVALIDO', 'Confira nome e perfil.', 'validation');
  if (input.senha.length < 12 || input.senha.length > 128)
    throw new DomainError(
      'SENHA_INVALIDA',
      'A senha deve ter entre 12 e 128 caracteres.',
      'validation',
    );
}
export function accountView(account: Account) {
  return { id: account.id, login: account.login, nome: account.name, perfil: account.role };
}
