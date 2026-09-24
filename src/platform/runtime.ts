import { createHash, randomUUID } from 'node:crypto';
import {
  Clock,
  Fingerprint,
  IdGenerator,
} from '../bounded-contexts/traceability/application/ports';

export class SystemClock implements Clock {
  now(): string {
    return new Date().toISOString();
  }
}
export class NodeIds implements IdGenerator {
  next(): string {
    return randomUUID();
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
export class Sha256Fingerprint implements Fingerprint {
  of(value: unknown): string {
    return createHash('sha256').update(canonical(value)).digest('hex');
  }
}
