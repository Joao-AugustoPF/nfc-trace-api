export const ROLES = ['ADMINISTRADOR', 'OPERADOR', 'CONSULTA'] as const;
export type Role = (typeof ROLES)[number];

/** Trusted metadata supplied by the server, never deserialized from a capture. */
export interface AuthenticatedActor {
  userId: string;
  sessionId: string;
  role: Role;
}

export class AccessError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly kind: 'unauthenticated' | 'forbidden' | 'rate-limited',
  ) {
    super(message);
    this.name = 'AccessError';
  }
}
