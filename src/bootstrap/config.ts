export interface AppConfig {
  databaseUrl: string;
  role: 'all' | 'api' | 'events';
  host: string;
  port: number;
  pollMs: number;
  leaseMs: number;
  batchSize: number;
  sessionSeconds: number;
}

function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new Error('Invalid numeric environment setting');
  return parsed;
}
export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const url = new URL(env.DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(url.protocol))
    throw new Error('DATABASE_URL must use PostgreSQL');
  const role = env.APP_PROCESS_ROLE ?? 'all';
  if (role !== 'all' && role !== 'api' && role !== 'events')
    throw new Error('Invalid APP_PROCESS_ROLE');
  return {
    databaseUrl: env.DATABASE_URL,
    role,
    host: env.HOST ?? '127.0.0.1',
    port: integer(env.PORT, 3000, 1, 65535),
    pollMs: integer(env.OUTBOX_POLL_MS, 1000, 10, 60000),
    leaseMs: integer(env.OUTBOX_LEASE_MS, 30000, 100, 300000),
    batchSize: integer(env.OUTBOX_BATCH_SIZE, 25, 1, 100),
    sessionSeconds: integer(env.AUTH_SESSION_SECONDS, 28800, 60, 86400),
  };
}
