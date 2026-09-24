import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createHttpApplication } from '../src/bootstrap/application';
import { readConfig } from '../src/bootstrap/config';
import { resetDatabase, seedIdentity, testDatabase, testPassword } from './support';
import { AuditConsumer } from '../src/platform/audit/audit-consumer';
import { OutboxDispatcher } from '../src/platform/messaging/outbox-dispatcher';
import { Identity1790000001000 } from '../src/platform/database/migrations/1790000001000-identity';
import { InitialSchema1790000000000 } from '../src/platform/database/migrations/1790000000000-initial-schema';
import { ManageAccounts } from '../src/bounded-contexts/identity/application/manage-accounts';
import { PostgresIdentityStore } from '../src/bounded-contexts/identity/infrastructure/postgres-identity-store';
import { ScryptPasswords } from '../src/bounded-contexts/identity/infrastructure/crypto';
import { NodeIds } from '../src/platform/runtime';

describe('Authenticated HTTP boundary and durable identity', () => {
  let source: DataSource;
  let app: INestApplication;
  let admin: Awaited<ReturnType<typeof seedIdentity>>;
  let operator: typeof admin;
  let viewer: typeof admin;
  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    post: (url: string) =>
      http()
        .post('/api/v1' + url)
        .auth(token, { type: 'bearer' }),
    get: (url: string) =>
      http()
        .get('/api/v1' + url)
        .auth(token, { type: 'bearer' }),
  });
  beforeAll(async () => {
    source = await testDatabase();
    app = await createHttpApplication(
      readConfig({ DATABASE_URL: 'postgresql://unused/db', APP_PROCESS_ROLE: 'api' }),
      source,
      false,
      true,
    );
  });
  beforeEach(async () => {
    await resetDatabase(source);
    admin = await seedIdentity(source, 'ADMINISTRADOR', 'admin.lab');
    operator = await seedIdentity(source, 'OPERADOR', 'operador.lab');
    viewer = await seedIdentity(source, 'CONSULTA', 'consulta.lab');
  });
  afterAll(async () => {
    await app?.close();
    if (source?.isInitialized) await source.destroy();
  });

  async function provision(strategy = 'UID') {
    const order = await as(admin.token).post('/pedidos').send({ codigo: randomUUID() }).expect(201);
    const tag = await as(admin.token)
      .post('/etiquetas')
      .send({
        pedidoId: order.body.dados.id,
        uid: '04AABBCCDDEE01',
        modelo: 'NTAG424DNA',
        estrategia: strategy,
      })
      .expect(201);
    await as(admin.token)
      .post('/provisionamentos/' + tag.body.dados.id + '/ativacao')
      .send({
        bloqueioConfirmado: true,
        ...(tag.body.dados.referenciaNdef ? { referenciaNdef: tag.body.dados.referenciaNdef } : {}),
      })
      .expect(200);
    return { orderId: order.body.dados.id as string, ...tag.body.dados };
  }
  function capture(id: string, type = 'COLETA') {
    return {
      id: randomUUID(),
      versaoContrato: 1,
      provisionamentoId: id,
      tipo: type,
      ocorridoEm: new Date().toISOString(),
      dispositivoId: 'declared-device',
      leituraBruta: { uid: '04AABBCCDDEE01' },
    };
  }
  const login = (name: string, password = testPassword) =>
    http().post('/api/v1/autenticacao/login').send({ login: name, senha: password });

  it('fails closed on every business route without changing logistics', async () => {
    const id = randomUUID();
    for (const path of [
      '/pedidos',
      '/etiquetas',
      '/eventos',
      '/usuarios',
      `/provisionamentos/${id}/ativacao`,
      `/provisionamentos/${id}/encerramento`,
    ]) {
      const denied = await http()
        .post('/api/v1' + path)
        .send({})
        .expect(401);
      expect(denied.body.codigo).toBe('SESSAO_INVALIDA');
    }
    for (const path of [
      '/pedidos',
      `/pedidos/${id}`,
      `/pedidos/${id}/eventos`,
      '/etiquetas/04AABBCCDDEE01',
      `/provisionamentos/${id}`,
      `/eventos/${id}`,
    ]) {
      await http()
        .get('/api/v1' + path)
        .expect(401);
    }
    await http().get('/metrics').expect(401);
    await http().get('/health/ready').expect(200);
    expect(await source.query('SELECT id FROM movements')).toHaveLength(0);
    expect(await source.query('SELECT id FROM observations')).toHaveLength(0);
    const audits = await source.query(
      "SELECT * FROM security_audit WHERE event_type='AcessoNegado'",
    );
    expect(audits).toHaveLength(13);
    expect(audits.every((row: { actor: unknown }) => row.actor === null)).toBe(true);
  });

  it('enforces the admin/operator/viewer permission matrix including provisioning changes', async () => {
    const p = await provision();
    for (const user of [operator, viewer]) {
      for (const path of [
        '/pedidos',
        '/etiquetas',
        '/usuarios',
        `/provisionamentos/${p.id}/ativacao`,
        `/provisionamentos/${p.id}/encerramento`,
        `/usuarios/${admin.id}/revogacao`,
        `/usuarios/${admin.id}/desativacao`,
      ]) {
        await as(user.token).post(path).send({}).expect(403);
      }
      for (const path of [
        '/pedidos',
        `/pedidos/${p.orderId}`,
        `/pedidos/${p.orderId}/eventos`,
        `/provisionamentos/${p.id}`,
        '/etiquetas/04AABBCCDDEE01',
      ])
        await as(user.token).get(path).expect(200);
    }
    await as(viewer.token).post('/eventos').send(capture(p.id)).expect(403);
    const allowed = await as(operator.token).post('/eventos').send(capture(p.id)).expect(200);
    expect(allowed.body.dados.decisao.autorizada).toBe(true);
    const rejected = await as(operator.token)
      .post('/eventos')
      .send(capture(p.id, 'ENTREGA'))
      .expect(200);
    expect(rejected.body.dados.decisao.autorizada).toBe(false);
    expect(await source.query('SELECT id FROM observations')).toHaveLength(2);
  });

  it.each(['UID', 'NDEF_ESTATICO'])(
    'retains verified author independently of hostile declarations for %s',
    async (strategy) => {
      const p = await provision(strategy);
      const body = { ...capture(p.id), operadorId: admin.id, dispositivoId: 'forged-admin-device' };
      if (p.referenciaNdef) Object.assign(body.leituraBruta, { ndef: p.referenciaNdef });
      const response = await as(operator.token).post('/eventos').send(body).expect(200);
      expect(response.body.dados.autoria).toMatchObject({
        tipo: 'AUTENTICADA',
        usuarioId: operator.id,
        perfil: 'OPERADOR',
      });
      expect(response.body.dados.operadorId).toBe(admin.id);
      await as(operator.token)
        .post('/eventos')
        .send({ ...capture(p.id), authenticatedActor: { userId: admin.id } })
        .expect(400);
      const dispatcher = new OutboxDispatcher(source, [new AuditConsumer()], {
        batchSize: 100,
        leaseMs: 1000,
      });
      await dispatcher.tick();
      const audit = await source.query(
        "SELECT payload FROM audit_log WHERE event_type='ObservacaoProcessada'",
      );
      expect(audit[0].payload.atorAutenticado.userId).toBe(operator.id);
      const provisioning = await source.query(
        "SELECT payload FROM audit_log WHERE event_type='EtiquetaAtivada'",
      );
      expect(provisioning[0].payload.atorAutenticado.userId).toBe(admin.id);
    },
  );

  it('retains original receipt for a new session of the same user, but blocks another submitter', async () => {
    const p = await provision();
    const body = capture(p.id);
    const first = await as(operator.token).post('/eventos').send(body).expect(200);
    const renewed = await login(operator.login).expect(200);
    const replay = await as(renewed.body.dados.tokenAcesso).post('/eventos').send(body).expect(200);
    expect(replay.body).toEqual(first.body);
    const other = await as(admin.token).post('/eventos').send(body).expect(409);
    expect(other.body.codigo).toBe('IDEMPOTENCIA_OPERADOR_DIVERGENTE');
    expect(await source.query("SELECT id FROM movements WHERE type='COLETA'")).toHaveLength(1);
  });

  it('returns generic login failures, never returns hashes, and persists only token digests', async () => {
    const bad = await login(operator.login, 'incorrect-password').expect(401);
    const unknown = await login('unknown.lab', 'incorrect-password').expect(401);
    expect(bad.body.codigo).toBe(unknown.body.codigo);
    expect(bad.body.mensagem).toBe(unknown.body.mensagem);
    const good = await login(operator.login).expect(200);
    expect(good.headers['cache-control']).toBe('no-store');
    const data = good.body.dados;
    expect(data.usuario).toEqual({
      id: operator.id,
      login: operator.login,
      nome: operator.login,
      perfil: 'OPERADOR',
    });
    expect(JSON.stringify(await source.query('SELECT * FROM identity_sessions'))).not.toContain(
      data.tokenAcesso,
    );
    const current = await as(data.tokenAcesso).get('/autenticacao/sessao').expect(200);
    expect(current.body.dados.usuario).toEqual(data.usuario);
    expect(JSON.stringify(await source.query('SELECT * FROM security_audit'))).not.toContain(
      testPassword,
    );
  });

  it('logs out only the current session and does not invalidate a different operator', async () => {
    const second = await login(operator.login).expect(200);
    await as(operator.token).post('/autenticacao/logout').expect(200);
    await as(operator.token).get('/pedidos').expect(401);
    await as(second.body.dados.tokenAcesso).get('/pedidos').expect(200);
    await as(admin.token).get('/pedidos').expect(200);
  });

  it('rejects expired, revoked and disabled sessions immediately on subsequent requests', async () => {
    await source.query(
      "UPDATE identity_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [viewer.sessionId],
    );
    await as(viewer.token).get('/pedidos').expect(401);
    const second = await login(operator.login).expect(200);
    await as(admin.token).post(`/usuarios/${operator.id}/revogacao`).expect(200);
    await as(operator.token).get('/pedidos').expect(401);
    await as(second.body.dados.tokenAcesso).get('/pedidos').expect(401);
    const next = await login(operator.login).expect(200);
    await as(admin.token).post(`/usuarios/${operator.id}/desativacao`).expect(200);
    await as(next.body.dados.tokenAcesso).get('/pedidos').expect(401);
    await login(operator.login).expect(401);
    await as(admin.token).post(`/usuarios/${admin.id}/desativacao`).expect(409);
  });

  it('allows explicit administrative creation, validates passwords and prevents duplicate accounts', async () => {
    const body = {
      login: 'nova.conta',
      nome: 'Pessoa do laboratório',
      senha: testPassword,
      perfil: 'OPERADOR',
    };
    await as(admin.token)
      .post('/usuarios')
      .send({ ...body, senha: 'short' })
      .expect(400);
    const created = await as(admin.token).post('/usuarios').send(body).expect(201);
    expect(created.body.dados).not.toHaveProperty('passwordHash');
    await as(admin.token).post('/usuarios').send(body).expect(409);
    const session = await login(body.login).expect(200);
    await as(session.body.dados.tokenAcesso).get('/pedidos').expect(200);
  });

  it('limits login attempts durably even across concurrent requests', async () => {
    for (let i = 0; i < 10; i++)
      await source.query(
        `INSERT INTO identity_login_limits (key,attempts,window_start)
      VALUES (encode(sha256(convert_to('login:' || $1,'UTF8')),'hex'),1,clock_timestamp())
      ON CONFLICT (key) DO UPDATE SET attempts=identity_login_limits.attempts+1`,
        [operator.login],
      );
    const results = await Promise.all([login(operator.login), login(operator.login)]);
    expect(results.map((x) => x.status)).toEqual([429, 429]);
    expect(results[0]!.headers['retry-after']).toBe('900');
    await source.query(
      "UPDATE identity_login_limits SET window_start=clock_timestamp()-interval '16 minutes'",
    );
    await login(operator.login).expect(200);
  });

  it('rolls back user creation, security audit and outbox together on publication failure', async () => {
    await source.query(`CREATE FUNCTION fail_auth_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test rollback'; END; $$;
      CREATE TRIGGER fail_auth_outbox BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION fail_auth_outbox();`);
    try {
      await as(admin.token)
        .post('/usuarios')
        .send({ login: 'rollback.lab', nome: 'Rollback', senha: testPassword, perfil: 'CONSULTA' })
        .expect(500);
      expect(
        await source.query("SELECT id FROM identity_accounts WHERE login='rollback.lab'"),
      ).toHaveLength(0);
      expect(await source.query('SELECT id FROM security_audit')).toHaveLength(0);
    } finally {
      await source.query(
        'DROP TRIGGER fail_auth_outbox ON outbox; DROP FUNCTION fail_auth_outbox();',
      );
    }
  });

  it('bootstraps exactly one administrator under concurrent explicit setup', async () => {
    await resetDatabase(source);
    const accounts = new ManageAccounts(
      new PostgresIdentityStore(source),
      new ScryptPasswords(),
      new NodeIds(),
    );
    const results = await Promise.allSettled(
      ['first.admin', 'other.admin'].map((login) =>
        accounts.create(
          { login, nome: 'Bootstrap', senha: testPassword, perfil: 'ADMINISTRADOR' },
          null,
          'bootstrap-test',
        ),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find((result) => result.status === 'rejected');
    expect(failure).toMatchObject({ status: 'rejected', reason: { code: 'BOOTSTRAP_CONCLUIDO' } });
    const rows = await source.query('SELECT login FROM identity_accounts');
    expect(rows).toHaveLength(1);
    await login(rows[0].login).expect(200);
  });

  it('upgrades existing v1 observations without inventing verified identity', async () => {
    const runner = source.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query('CREATE SCHEMA identity_upgrade_test');
      await runner.query('SET LOCAL search_path TO identity_upgrade_test');
      await new InitialSchema1790000000000().up(runner);
      const id = randomUUID();
      await runner.query(
        "INSERT INTO observations (id,provisioning_id,fingerprint,input,received_at) VALUES ($1,$2,'legacy',$3,clock_timestamp())",
        [id, randomUUID(), { operadorId: 'declarado' }],
      );
      await new Identity1790000001000().up(runner);
      const rows = await runner.query('SELECT input,authenticated_actor FROM observations');
      expect(rows).toEqual([{ input: { operadorId: 'declarado' }, authenticated_actor: null }]);
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  });
});
