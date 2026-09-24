import { Account } from '../domain/account';
import { AuthenticatedActor } from '../../../shared-kernel/actor';

export interface Session {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
}
export interface SecurityEvent {
  type: string;
  actor: AuthenticatedActor | null;
  subjectId?: string;
  correlationId: string;
  outcome: 'ACEITO' | 'NEGADO';
  reason?: string;
  route?: string;
}
export interface IdentityTransaction {
  accounts: {
    byLogin(login: string): Promise<Account | null>;
    get(id: string): Promise<Account | null>;
    insert(account: Account): Promise<void>;
    disable(id: string): Promise<void>;
    lockBootstrap(): Promise<void>;
    count(): Promise<number>;
  };
  sessions: {
    insert(session: Session): Promise<void>;
    revoke(id: string, userId: string): Promise<void>;
    revokeAll(userId: string): Promise<void>;
  };
  audit(event: SecurityEvent): Promise<void>;
}
export interface IdentityStore {
  run<T>(work: (tx: IdentityTransaction) => Promise<T>): Promise<T>;
  accountByLogin(login: string): Promise<Account | null>;
  session(tokenHash: string): Promise<{ session: Session; account: Account } | null>;
  consumeLoginAttempt(login: string, address: string): Promise<boolean>;
  audit(event: SecurityEvent): Promise<void>;
}
export interface Passwords {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
  dummyHash(): Promise<string>;
}
export interface Tokens {
  issue(): string;
  digest(token: string): string;
}
export interface IdentityClock {
  now(): string;
}
export interface IdentityIds {
  next(): string;
}
