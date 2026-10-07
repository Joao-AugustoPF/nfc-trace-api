import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createHttpApplication } from '../src/bootstrap/application';
import { readConfig } from '../src/bootstrap/config';
import {
  ImportNfcInventory,
  NfcAdministration,
} from '../src/bounded-contexts/tag-administration/application/administration-service';
import { NodeCredentialVault } from '../src/bounded-contexts/tag-administration/infrastructure/credential-vault';
import { Ev2InspectionGateway } from '../src/bounded-contexts/tag-administration/infrastructure/ev2-inspection-gateway';
import { PostgresAdministrationStore } from '../src/bounded-contexts/tag-administration/infrastructure/postgres-administration-store';
import { NodeIds, Sha256Fingerprint, SystemClock } from '../src/platform/runtime';
import { resetDatabase, seedIdentity, testDatabase } from './support';
import { SyntheticInspectionPicc } from './nfc-picc-fixture';
import { privateOutput } from '../src/platform/access/sdm-keys-cli';
import { createOpenApiDocument } from '../src/bootstrap/openapi';

describe('Administrative NFC inventory/journal over PostgreSQL and HTTP (synthetic PICC)', () => {
  let source: DataSource, app: INestApplication, user: Awaited<ReturnType<typeof seedIdentity>>;
  const uid = '04112233445566',
    station = 'bancada-sintetica',
    versions = [10, 11, 12, 13, 14];
  const keys = randomBytes(80),
    masters = JSON.stringify({ '1': randomBytes(32).toString('base64') });
  const vault = new NodeCredentialVault('1', masters);
  const config = readConfig({
    DATABASE_URL: 'postgresql://unused@localhost/test',
    APP_PROCESS_ROLE: 'api',
    SDM_ACTIVE_MASTER_VERSION: '1',
    SDM_MASTER_KEYS_JSON: masters,
  });
  const importer = () =>
    new ImportNfcInventory(
      new PostgresAdministrationStore(source),
      vault,
      new SystemClock(),
      new NodeIds(),
    );
  const post = (path: string, token = user.token) =>
    request(app.getHttpServer())
      .post('/api/v1' + path)
      .auth(token, { type: 'bearer' });
  const get = (path: string) =>
    request(app.getHttpServer())
      .get('/api/v1' + path)
      .auth(user.token, { type: 'bearer' });
  const root = '/administracao-nfc/inspecoes';
  beforeAll(async () => {
    source = await testDatabase();
    app = await createHttpApplication(config, source, false, true);
  });
  beforeEach(async () => {
    await resetDatabase(source);
    user = await seedIdentity(source);
  });
  afterAll(async () => {
    vault.close();
    await app?.close();
    if (source?.isInitialized) await source.destroy();
  });
  async function provisioning(model = 'NTAG424DNA') {
    const order = (await post('/pedidos').send({ codigo: randomUUID() }).expect(201)).body.dados.id;
    return (
      await post('/etiquetas')
        .send({ pedidoId: order, uid, modelo: model, estrategia: 'UID' })
        .expect(201)
    ).body.dados.id as string;
  }
  async function prepare() {
    const link = await provisioning();
    await importer().execute(uid, versions, keys);
    const id = randomUUID();
    await post(root).send({ id, provisionamentoId: link, estacao: station }).expect(201);
    return { id, link };
  }
  async function start(id: string, recuperar = false) {
    const body = { id: randomUUID(), sessaoRfId: randomUUID(), estacao: station, recuperar };
    const reply = (await post(`${root}/${id}/sessoes`).send(body).expect(200)).body.dados;
    return { body, reply };
  }
  const respond = (
    id: string,
    s: Awaited<ReturnType<typeof start>>,
    hex: string,
    commandId = s.reply.comando.id,
  ) =>
    post(`${root}/${id}/sessoes/${s.body.id}/respostas`).send({
      comandoId: commandId,
      sessaoRfId: s.body.sessaoRfId,
      estacao: station,
      respostaHex: hex,
    });
  it('keeps login and NFC session schemas separate in the public OpenAPI contract', () => {
    const document = createOpenApiDocument(app);
    expect(document.components?.schemas?.SessionResponse).toHaveProperty('properties.usuario');
    expect(document.components?.schemas?.SessionResponse).not.toHaveProperty('properties.comando');
    expect(document.components?.schemas?.NfcInspectionSessionResponse).toHaveProperty(
      'properties.comando',
    );
    expect(document.components?.schemas?.NfcInspectionSessionResponse).not.toHaveProperty(
      'properties.usuario',
    );
    const auth = JSON.stringify(document.paths['/api/v1/autenticacao/sessao']?.get?.responses);
    const inspection = JSON.stringify(
      document.paths[
        root.replace('/administracao-nfc', '/api/v1/administracao-nfc') + '/{id}/sessoes'
      ]?.post?.responses,
    );
    expect(auth).toContain('#/components/schemas/SessionResponse');
    expect(inspection).toContain('#/components/schemas/NfcInspectionSessionResponse');
  });
  it('requires administrator, private inventory, supported model, pending binding and strict input', async () => {
    const operator = await seedIdentity(source, 'OPERADOR');
    await post(root, operator.token)
      .send({ id: randomUUID(), provisionamentoId: randomUUID(), estacao: station })
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/v1' + root)
      .send({})
      .expect(401);
    const link = await provisioning();
    const input = { id: randomUUID(), provisionamentoId: link, estacao: station };
    expect((await post(root).send(input).expect(409)).body.codigo).toBe('NFC_INVENTARIO_AUSENTE');
    await post(root)
      .send({ ...input, chaveHex: 'not-accepted' })
      .expect(400);
    await importer().execute(uid, versions, keys);
    await post('/provisionamentos/' + link + '/ativacao')
      .send({ bloqueioConfirmado: true })
      .expect(200);
    expect((await post(root).send(input).expect(409)).body.codigo).toBe('NFC_VINCULO_NAO_PENDENTE');
  });
  it('refuses Feiju even with imported credentials', async () => {
    const link = await provisioning('Feiju');
    await importer().execute(uid, versions, keys);
    await post(root)
      .send({ id: randomUUID(), provisionamentoId: link, estacao: station })
      .expect(422);
  });
  it('imports through the real private-file CLI and emits only a reference', async () => {
    const path = resolve('.tmp/private', `nfc-inventory-test-${randomUUID()}.json`);
    const payload = {
      uid,
      slots: versions.map((versao, numero) => ({
        numero,
        versao,
        chaveHex: Buffer.from(keys.subarray(numero * 16, numero * 16 + 16)).toString('hex'),
      })),
    };
    privateOutput(path, JSON.stringify(payload));
    try {
      if (process.platform === 'win32')
        execFileSync('icacls', [path, '/grant', '*S-1-5-32-545:(R)'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      const output = execFileSync(
        process.execPath,
        [
          '-r',
          'ts-node/register',
          'src/platform/access/nfc-inventory-cli.ts',
          'import',
          '--input',
          path,
        ],
        {
          cwd: resolve('.'),
          encoding: 'utf8',
          windowsHide: true,
          env: {
            ...process.env,
            DATABASE_URL: 'url' in source.options ? source.options.url : undefined,
            SDM_ACTIVE_MASTER_VERSION: '1',
            SDM_MASTER_KEYS_JSON: masters,
          },
        },
      );
      expect(JSON.parse(output)).toMatchObject({ declarado: true, autenticadoFisicamente: false });
      expect(output).not.toContain(payload.slots[0]!.chaveHex);
      if (process.platform === 'win32') {
        const aclCheck =
          '$identity=[System.Security.Principal.WindowsIdentity]::GetCurrent(); ' +
          '$rules=[System.IO.File]::GetAccessControl($env:TASK_NFC_PRIVATE_INPUT).GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]); ' +
          'if($rules.Count -ne 1 -or $rules[0].IdentityReference -ne $identity.User -or $rules[0].IsInherited){exit 1;}';
        execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-WindowStyle',
            'Hidden',
            '-EncodedCommand',
            Buffer.from(aclCheck, 'utf16le').toString('base64'),
          ],
          {
            stdio: 'ignore',
            windowsHide: true,
            env: { ...process.env, TASK_NFC_PRIVATE_INPUT: path },
          },
        );
      }
      const record = await new PostgresAdministrationStore(source).run((tx) => tx.credential(uid));
      const plain = vault.unseal(record!);
      expect(Buffer.from(plain)).toEqual(keys);
      plain.fill(0);
      const event = (
        await source.query(
          "SELECT envelope FROM outbox WHERE envelope->>'type'='InventarioNfcDeclarado'",
        )
      )[0].envelope;
      expect(event.payload.origem).toBe('CLI_LOCAL');
    } finally {
      unlinkSync(path);
    }
  });
  it('rejects forged UID, wrong version and wrong non-master key instead of trying defaults', async () => {
    for (const fault of ['UID', 'VERSAO', 'CHAVE']) {
      await resetDatabase(source);
      user = await seedIdentity(source);
      const { id } = await prepare(),
        s = await start(id);
      const alteredKeys = Buffer.from(keys);
      if (fault === 'CHAVE') alteredKeys[16] = alteredKeys[16]! ^ 1;
      const picc = new SyntheticInspectionPicc(
        alteredKeys,
        fault === 'VERSAO' ? [9, ...versions.slice(1)] : versions,
        fault === 'UID' ? '04112233445567' : uid,
      );
      while (s.reply.comando) {
        s.reply = (
          await respond(id, s, picc.respond(s.reply.comando.apduHex)).expect(200)
        ).body.dados;
      }
      expect(s.reply.status).toBe('INTERROMPIDA');
      expect(s.reply.codigo).toBe(
        fault === 'UID'
          ? 'NFC_ADMIN_UID_DIVERGENTE'
          : fault === 'VERSAO'
            ? 'NFC_VERSAO_DIVERGENTE'
            : 'NFC_ADMIN_STATUS_RECUSADO',
      );
      expect(s.reply.resultado).toBeNull();
    }
  });
  it('serializes preparation; seals inventory and retains old references on replacement', async () => {
    const link = await provisioning();
    const first = await importer().execute(uid, versions, keys);
    const id = randomUUID(),
      body = { id, provisionamentoId: link, estacao: station };
    const replies = await Promise.all([post(root).send(body), post(root).send(body)]);
    expect(replies.map((r) => r.status)).toEqual([201, 201]);
    expect(replies[0].body.dados).toEqual(replies[1].body.dados);
    await post(root)
      .send({ ...body, estacao: 'other' })
      .expect(409);
    await post(root)
      .send({ ...body, id: randomUUID() })
      .expect(409);
    await expect(importer().execute(uid, versions, keys)).rejects.toMatchObject({
      code: 'NFC_INVENTARIO_EM_USO',
    });
    await post(`${root}/${id}/encerramento`).send({ estacao: station }).expect(200);
    const second = await importer().execute(uid, versions, randomBytes(80));
    expect(second.reference).not.toBe(first.reference);
    expect((await source.query('SELECT count(*)::int AS n FROM nfc_credentials'))[0].n).toBe(2);
    const serialized =
      JSON.stringify(await source.query('SELECT sealed FROM nfc_credentials')) +
      JSON.stringify(await source.query('SELECT envelope FROM outbox'));
    for (let slot = 0; slot < 5; slot++)
      expect(serialized).not.toContain(
        Buffer.from(keys.subarray(slot * 16, slot * 16 + 16)).toString('hex'),
      );
  });
  it('verifies all five secrets/versions/UID with durable intentions, no writes or activation', async () => {
    const { id, link } = await prepare(),
      s = await start(id),
      picc = new SyntheticInspectionPicc(keys, versions, uid);
    let count = 0;
    while (s.reply.comando) {
      const cmd = s.reply.comando;
      const row = (
        await source.query(
          "SELECT details FROM nfc_admin_journal WHERE id=$1 AND type='INTENCAO'",
          [cmd.id],
        )
      )[0];
      expect(row.details.alteraTag).toBe(false);
      s.reply = (await respond(id, s, picc.respond(cmd.apduHex)).expect(200)).body.dados;
      count++;
      expect(count).toBeLessThan(30);
    }
    expect(count).toBe(21);
    expect(s.reply).toMatchObject({
      status: 'CONCLUIDA',
      resultado: {
        uid,
        versoesChaves: versions,
        slotsAutenticados: [0, 1, 2, 3, 4],
        personalizada: false,
      },
    });
    expect((await get(`${root}/${id}`).expect(200)).body.dados.status).toBe('INSPECIONADA');
    expect((await get('/provisionamentos/' + link).expect(200)).body.dados.status).toBe(
      'REGISTRADA',
    );
    const history = (await get(`${root}/${id}/diario?pagina=2&limite=10`).expect(200)).body.dados;
    expect(history.total).toBe(44);
    expect(history.itens).toHaveLength(10);
    expect(JSON.stringify(history)).not.toContain('chaveHex');
  });
  it('replays HTTP checkpoints without advancing twice or returning an obsolete APDU', async () => {
    const { id } = await prepare(),
      s = await start(id),
      picc = new SyntheticInspectionPicc(keys, versions, uid);
    const initial = s.reply.comando,
      answer = picc.respond(initial.apduHex);
    const replies = await Promise.all([
      respond(id, s, answer),
      respond(id, s, answer.toUpperCase()),
    ]);
    expect(replies.map((r) => r.status)).toEqual([200, 200]);
    expect(replies[0].body.dados).toEqual(replies[1].body.dados);
    s.reply = replies[0].body.dados;
    await respond(id, s, '000091AF', initial.id).expect(409);
    s.reply = (await respond(id, s, picc.respond(s.reply.comando.apduHex)).expect(200)).body.dados;
    const replay = await respond(id, s, answer, initial.id).expect(200);
    expect(replay.body.dados.comando.id).toBe(s.reply.comando.id);
    expect((await source.query('SELECT count(*)::int AS n FROM nfc_admin_responses'))[0].n).toBe(2);
  });
  it('stores protocol rejection, requires recovery and rejects RF identity reuse', async () => {
    const { id } = await prepare(),
      s = await start(id);
    const bad = await respond(id, s, '9100').expect(200);
    expect(bad.body.dados).toMatchObject({
      status: 'INTERROMPIDA',
      codigo: 'NFC_ADMIN_STATUS_RECUSADO',
      comando: null,
    });
    await post(`${root}/${id}/sessoes`)
      .send({ ...s.body, id: randomUUID(), sessaoRfId: randomUUID() })
      .expect(409);
    await post(`${root}/${id}/sessoes`)
      .send({ ...s.body, id: randomUUID(), recuperar: true })
      .expect(409);
    const recovered = await start(id, true);
    expect(recovered.reply.comando.etapa).toBe('AUTH_0_DESAFIO');
    await respond(id, s, '9100').expect(409);
  });
  it('allows explicit RF cancellation after new login, keeping the immutable recovery plan', async () => {
    const { id } = await prepare(),
      s = await start(id);
    const original = (await get(`${root}/${id}`).expect(200)).body.dados;
    const other = await seedIdentity(source);
    const path = `${root}/${id}/sessoes/${s.body.id}/interrupcao`,
      body = { estacao: station, sessaoRfId: s.body.sessaoRfId };
    await post(path, other.token).send(body).expect(403);
    await source.query('UPDATE identity_sessions SET revoked_at=clock_timestamp() WHERE id=$1', [
      user.sessionId,
    ]);
    const login = (
      await request(app.getHttpServer())
        .post('/api/v1/autenticacao/login')
        .send({ login: user.login, senha: 'Laboratorio-Teste-2026' })
        .expect(200)
    ).body.dados;
    user.token = login.tokenAcesso;
    expect((await post(path).send(body).expect(200)).body.dados).toMatchObject({
      status: 'INTERROMPIDA',
      codigo: 'NFC_CANCELADA',
    });
    await post(path).send(body).expect(200);
    await start(id, true);
    const recovered = (await get(`${root}/${id}`).expect(200)).body.dados;
    expect(recovered.hashPlano).toBe(original.hashPlano);
    expect(recovered.plano).toEqual(original.plano);
  });
  it('preserves journal on server restart, and never resumes a lost EV2 session', async () => {
    const { id } = await prepare(),
      s = await start(id);
    await app.close();
    app = await createHttpApplication(config, source, false, true);
    expect((await get(`${root}/${id}`).expect(200)).body.dados.status).toBe('INTERROMPIDA');
    const retry = await post(`${root}/${id}/sessoes`).send(s.body).expect(200);
    expect(retry.body.dados).toMatchObject({
      status: 'INTERROMPIDA',
      codigo: 'NFC_SESSAO_PERDIDA',
      comando: null,
    });
    expect((await start(id, true)).reply.comando.etapa).toBe('AUTH_0_DESAFIO');
  });
  it('binds responses to account, identity session, station and RF session', async () => {
    const { id } = await prepare(),
      s = await start(id),
      other = await seedIdentity(source);
    const path = `${root}/${id}/sessoes/${s.body.id}/respostas`;
    const body = {
      comandoId: s.reply.comando.id,
      sessaoRfId: s.body.sessaoRfId,
      estacao: station,
      respostaHex: '9100',
    };
    await post(path, other.token).send(body).expect(403);
    await post(path)
      .send({ ...body, estacao: 'another-station' })
      .expect(403);
    await post(path)
      .send({ ...body, sessaoRfId: randomUUID() })
      .expect(403);
    await source.query('UPDATE identity_sessions SET revoked_at=clock_timestamp() WHERE id=$1', [
      user.sessionId,
    ]);
    await post(path).send(body).expect(401);
  });
  it('revalidates binding even on begin retry; cancellation is idempotent', async () => {
    const { id, link } = await prepare(),
      s = await start(id);
    await post('/provisionamentos/' + link + '/encerramento').expect(200);
    const replay = await post(`${root}/${id}/sessoes`).send(s.body).expect(200);
    expect(replay.body.dados).toMatchObject({
      status: 'INTERROMPIDA',
      codigo: 'NFC_VINCULO_NAO_PENDENTE',
      comando: null,
    });
    await post(`${root}/${id}/encerramento`).send({ estacao: station }).expect(200);
    await post(`${root}/${id}/encerramento`).send({ estacao: station }).expect(200);
    expect(
      (
        await source.query(
          "SELECT count(*)::int AS n FROM nfc_admin_journal WHERE type='ENCERRADA'",
        )
      )[0].n,
    ).toBe(1);
  });
  it('expires leases without extending them, and requires a new RF session', async () => {
    const { id } = await prepare();
    let now = Date.now();
    const gateway = new Ev2InspectionGateway(vault);
    const service = new NfcAdministration(
      new PostgresAdministrationStore(source),
      gateway,
      { now: () => new Date(now).toISOString() },
      new NodeIds(),
      new Sha256Fingerprint(),
      3,
    );
    const actor = { userId: user.id, sessionId: user.sessionId, role: user.role };
    const input = { id: randomUUID(), rfSessionId: randomUUID(), station, recovery: false };
    const initial = await service.begin(id, input, actor);
    now += 4000;
    expect((await service.get(id, actor)).state).toBe('INTERROMPIDA');
    expect(await service.begin(id, input, actor)).toMatchObject({
      state: 'INTERROMPIDA',
      errorCode: 'NFC_SESSAO_EXPIRADA',
      expiresAt: initial.expiresAt,
      command: null,
    });
    gateway.closeAll();
  });
  it('rolls back intention, session and outbox together; the live channel is discarded', async () => {
    const { id } = await prepare();
    await source.query(`CREATE FUNCTION test_reject_nfc_intent() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.envelope->>'type'='AdministracaoNfcINTENCAO' THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER test_fail_nfc BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION test_reject_nfc_intent();`);
    try {
      await post(`${root}/${id}/sessoes`)
        .send({ id: randomUUID(), sessaoRfId: randomUUID(), estacao: station, recuperar: false })
        .expect(500);
      expect((await source.query('SELECT count(*)::int AS n FROM nfc_admin_sessions'))[0].n).toBe(
        0,
      );
      expect(
        (
          await source.query(
            "SELECT count(*)::int AS n FROM nfc_admin_journal WHERE type='INTENCAO'",
          )
        )[0].n,
      ).toBe(0);
      expect((await get(`${root}/${id}`).expect(200)).body.dados.status).toBe('PREPARADA');
    } finally {
      await source.query(
        'DROP TRIGGER test_fail_nfc ON outbox; DROP FUNCTION test_reject_nfc_intent();',
      );
    }
    expect((await start(id)).reply.status).toBe('EM_ANDAMENTO');
  });
  it('protects stored plans, credentials, responses and journal from rewriting', async () => {
    const { id } = await prepare(),
      s = await start(id);
    await respond(id, s, '9100').expect(200);
    for (const sql of [
      "UPDATE nfc_inspections SET plan='{}'::jsonb",
      "UPDATE nfc_credentials SET sealed='{}'::jsonb",
      'DELETE FROM nfc_admin_journal',
      "UPDATE nfc_admin_responses SET fingerprint='changed'",
      "UPDATE nfc_admin_sessions SET expires_at=clock_timestamp()+interval '1 year'",
    ])
      await expect(source.query(sql)).rejects.toMatchObject({ driverError: { code: '23514' } });
  });
  it('discards an advanced in-memory channel if its response transaction rolls back', async () => {
    const { id } = await prepare(),
      s = await start(id),
      picc = new SyntheticInspectionPicc(keys, versions, uid);
    const original = s.reply.comando,
      answer = picc.respond(original.apduHex);
    await source.query(`CREATE FUNCTION test_reject_nfc_response() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.envelope->>'type'='AdministracaoNfcRESPOSTA' THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER test_fail_nfc_response BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION test_reject_nfc_response();`);
    try {
      await respond(id, s, answer).expect(500);
      expect((await source.query('SELECT count(*)::int AS n FROM nfc_admin_responses'))[0].n).toBe(
        0,
      );
      expect(
        (
          await source.query(
            "SELECT count(*)::int AS n FROM nfc_admin_journal WHERE type='INTENCAO'",
          )
        )[0].n,
      ).toBe(1);
    } finally {
      await source.query(
        'DROP TRIGGER test_fail_nfc_response ON outbox; DROP FUNCTION test_reject_nfc_response();',
      );
    }
    const retry = await respond(id, s, answer).expect(200);
    expect(retry.body.dados).toMatchObject({
      status: 'INTERROMPIDA',
      codigo: 'NFC_SESSAO_PERDIDA',
      comando: null,
    });
    expect((await start(id, true)).reply.comando.etapa).toBe('AUTH_0_DESAFIO');
  });
});
