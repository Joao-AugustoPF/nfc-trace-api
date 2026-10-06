import { Controller, Get, Header, ServiceUnavailableException } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { DataSource } from 'typeorm';
import { PublicAccess, AllowRoles } from '../access/http-security';

@ApiExcludeController()
@Controller()
export class HealthController {
  constructor(private readonly source: DataSource) {}
  @PublicAccess()
  @Get('health/live')
  live() {
    return { status: 'ok' };
  }
  @PublicAccess()
  @Get('health/ready')
  async ready() {
    try {
      await this.source.query('SELECT 1 FROM outbox LIMIT 1');
      await this.source.query('SELECT token_hash FROM identity_sessions LIMIT 1');
      return { status: 'ready' };
    } catch {
      throw new ServiceUnavailableException('PostgreSQL ou migrations indisponíveis.');
    }
  }
  @Get('metrics')
  @AllowRoles('ADMINISTRADOR')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async metrics(): Promise<string> {
    const rows: { status: string; total: string }[] = await this.source.query(
      'SELECT status, COUNT(*) AS total FROM outbox GROUP BY status',
    );
    const age: { seconds: number | null }[] = await this.source.query(`SELECT EXTRACT(EPOCH FROM
      clock_timestamp() - MIN(created_at))::float AS seconds FROM outbox WHERE status IN ('PENDING','PROCESSING')`);
    const values = new Map(rows.map((row) => [row.status, row.total]));
    return (
      '# TYPE nfc_outbox_events gauge\n' +
      ['PENDING', 'PROCESSING', 'FAILED', 'PROCESSED']
        .map((status) => `nfc_outbox_events{status="${status}"} ${values.get(status) ?? 0}\n`)
        .join('') +
      '# TYPE nfc_outbox_oldest_pending_seconds gauge\n' +
      `nfc_outbox_oldest_pending_seconds ${Math.max(0, age[0]?.seconds ?? 0)}\n`
    );
  }
}
