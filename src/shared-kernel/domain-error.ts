export type ErrorKind = 'validation' | 'not-found' | 'conflict' | 'unsupported' | 'unavailable';

export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly kind: ErrorKind = 'validation',
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
