import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createHttpApplication } from '../src/bootstrap/application';
import { readConfig } from '../src/bootstrap/config';
import {
  ImportNfcInventory,
  NfcAdministration,
} from '../src/bounded-contexts/tag-administration/application/administration-service';
import { RewrapNfcInventory } from '../src/bounded-contexts/tag-administration/application/rewrap-inventory';
import { NodeCredentialVault } from '../src/bounded-contexts/tag-administration/infrastructure/credential-vault';
import { NodeTargetGenerator } from '../src/bounded-contexts/tag-administration/infrastructure/target-generator';
import { PostgresAdministrationStore } from '../src/bounded-contexts/tag-administration/infrastructure/postgres-administration-store';
import { Ev2AdministrationGateway } from '../src/bounded-contexts/tag-administration/infrastructure/ev2-personalization-gateway';
import { NodeSdmCryptography } from '../src/bounded-contexts/traceability/infrastructure/sdm-crypto';
import {
  AdministrationStore,
  CredentialVault,
  SessionReply,
} from '../src/bounded-contexts/tag-administration/application/ports';
import { MaterialChoice } from '../src/bounded-contexts/tag-administration/domain/personalization-plan';
import { NodeIds, Sha256Fingerprint, SystemClock } from '../src/platform/runtime';
import { testDatabase, resetDatabase, seedIdentity } from './support';
import { SyntheticPersonalizationPicc } from './nfc-personalization-picc';
import { TypeOrmUnitOfWork } from '../src/bounded-contexts/traceability/infrastructure/typeorm-unit-of-work';
import { ActivateProvisioning } from '../src/bounded-contexts/traceability/application/change-provisioning';

describe('Durable NFC personalization (synthetic PICC, real PostgreSQL/HTTP)', () => {
  let source: DataSource, app: INestApplication, user: Awaited<ReturnType<typeof seedIdentity>>;
  const uid = '04112233445566',
    station = 'bancada-personalizacao',
    versions = [0, 0, 0, 0, 0],
    keys = randomBytes(80);
  const masters = JSON.stringify({ '1': randomBytes(32).toString('base64') });
  const config = readConfig({
    DATABASE_URL: 'postgresql://unused@localhost/test',
    APP_PROCESS_ROLE: 'api',
    SDM_ACTIVE_MASTER_VERSION: '1',
    SDM_MASTER_KEYS_JSON: masters,
  });
  const vault = new NodeCredentialVault('1', masters),
    sdm = new NodeSdmCryptography('1', masters);
  const store = () => new PostgresAdministrationStore(source);
  const post = (p: string) =>
    request(app.getHttpServer())
      .post('/api/v1' + p)
      .auth(user.token, { type: 'bearer' });
  const get = (p: string) =>
    request(app.getHttpServer())
      .get('/api/v1' + p)
      .auth(user.token, { type: 'bearer' });
  const root = '/administracao-nfc/operacoes';
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
  async function prepare(strategy = 'UID') {
    const order = (await post('/pedidos').send({ codigo: randomUUID() }).expect(201)).body.dados
      .id as string;
    const link = (
      await post('/etiquetas')
        .send({
          pedidoId: order,
          uid,
          modelo: 'NTAG424DNA',
          estrategia: strategy,
          ...(strategy === 'SDM' ? { politicaSdm: 'ESTRITA' } : {}),
        })
        .expect(201)
    ).body.dados.id as string;
    const current = await new ImportNfcInventory(
      store(),
      vault,
      new SystemClock(),
      new NodeIds(),
    ).execute(uid, versions, keys);
    const id = randomUUID(),
      body = { id, provisionamentoId: link, estacao: station };
    const op = (await post('/administracao-nfc/personalizacoes').send(body).expect(201)).body.dados;
    const target = (await store().run((tx) =>
      tx.credentialById(op.plano.personalizacao.referenciaAlvo),
    ))!;
    const targetKeys = vault.unseal(target);
    return {
      id,
      link,
      order,
      body,
      op,
      target,
      targetKeys,
      current: current.reference,
      picc: new SyntheticPersonalizationPicc(keys, versions, uid),
    };
  }
  async function start(id: string, recuperar = false, materiais?: MaterialChoice[]) {
    const body = {
      id: randomUUID(),
      sessaoRfId: randomUUID(),
      estacao: station,
      recuperar,
      ...(materiais ? { materiais } : {}),
    };
    const reply = (await post(`${root}/${id}/sessoes`).send(body).expect(200)).body.dados;
    return { body, reply };
  }
  const respond = (id: string, s: Awaited<ReturnType<typeof start>>, hex: string) =>
    post(`${root}/${id}/sessoes/${s.body.id}/respostas`).send({
      comandoId: s.reply.comando.id,
      sessaoRfId: s.body.sessaoRfId,
      estacao: station,
      respostaHex: hex,
    });
  async function advance(
    p: Awaited<ReturnType<typeof prepare>>,
    s: Awaited<ReturnType<typeof start>>,
    until?: string,
  ) {
    let count = 0;
    while (s.reply.comando && s.reply.comando.etapa !== until) {
      if (++count > 120) throw Error('Unexpected workflow length');
      s.reply = (
        await respond(p.id, s, p.picc.respond(s.reply.comando.apduHex)).expect(200)
      ).body.dados;
    }
    return count;
  }
  async function interrupt(
    p: Awaited<ReturnType<typeof prepare>>,
    s: Awaited<ReturnType<typeof start>>,
  ) {
    return (
      await post(`${root}/${p.id}/sessoes/${s.body.id}/interrupcao`)
        .send({ sessaoRfId: s.body.sessaoRfId, estacao: station })
        .expect(200)
    ).body.dados;
  }
  it.each(['UID', 'NDEF_ESTATICO', 'SDM'])(
    'installs and verifies %s with master last, small frames, immutable target and deferred activation',
    async (strategy) => {
      const p = await prepare(strategy);
      const same = (await post('/administracao-nfc/personalizacoes').send(p.body).expect(201)).body
        .dados;
      expect(same).toEqual(p.op);
      expect(
        (await get(`/administracao-nfc/provisionamentos/${p.link}/personalizacao`).expect(200)).body
          .dados,
      ).toEqual(p.op);
      expect(
        (
          await post('/administracao-nfc/personalizacoes')
            .send({ ...p.body, id: randomUUID() })
            .expect(409)
        ).body.codigo,
      ).toBe('NFC_ETIQUETA_EM_USO');
      expect(
        (
          await post('/provisionamentos/' + p.link + '/ativacao')
            .send({ bloqueioConfirmado: true })
            .expect(409)
        ).body.codigo,
      ).toBe('NFC_PERSONALIZACAO_PENDENTE');
      const s = await start(p.id);
      await advance(p, s);
      expect(s.reply).toMatchObject({
        status: 'CONCLUIDA',
        alteracaoFisica: 'CONFERIDA',
        resultado: { personalizada: true, slotsAutenticados: [0, 1, 2, 3, 4] },
      });
      expect(p.picc.keys).toEqual(Buffer.from(p.targetKeys));
      expect(p.picc.versions).toEqual(p.target.versions);
      expect(p.picc.files.get(2)!.toString('hex').toUpperCase()).toBe(
        p.op.plano.personalizacao.imagemNdefHex,
      );
      expect(p.picc.settings.get(2)!.toString('hex').toUpperCase()).toBe(
        p.op.plano.personalizacao.configuracaoNdefFinalHex,
      );
      expect(p.picc.files.get(1)![14]).toBe(255);
      expect(p.picc.sdmCounterResets).toBe(strategy === 'SDM' ? 1 : 0);
      expect((await store().run((tx) => tx.credential(uid)))!.id).toBe(p.target.id);
      expect((await get('/provisionamentos/' + p.link).expect(200)).body.dados.status).toBe(
        'REGISTRADA',
      );
      const journal = (await store().run((tx) => tx.journal(p.id, 1, 100))).items;
      expect(journal.some((e) => e.type === 'DADOS_CONFERIDOS')).toBe(true);
      const json = JSON.stringify(
        (await get(`${root}/${p.id}/diario?limite=100`).expect(200)).body,
      );
      expect(json).not.toContain(Buffer.from(p.targetKeys.subarray(0, 16)).toString('hex'));
      if (strategy === 'SDM') {
        const gate = (await store().run((tx) => tx.provisioning(p.link)))!;
        expect(Buffer.from(p.targetKeys.subarray(16, 48))).toEqual(
          sdm.unseal(p.link, gate.sdm!, gate.sdm!.sealed),
        );
      } else {
        await post('/provisionamentos/' + p.link + '/ativacao')
          .send({
            bloqueioConfirmado: true,
            ...(strategy === 'NDEF_ESTATICO'
              ? { referenciaNdef: `urn:nfc-trace:provisioning:${p.link}` }
              : {}),
          })
          .expect(200);
      }
      p.targetKeys.fill(0);
    },
  );
  it.each([
    'ACESSO_PROTEGIDO_CC',
    'GRAVAR_NDEF_2',
    'GRAVAR_NDEF_NLEN_FINAL',
    'TROCAR_CHAVE_1',
    'TROCAR_CHAVE_0',
    'APLICAR_CONFIG_NDEF',
  ])('recovers loss of %s ACK using the SAME target and explicit slot choices', async (step) => {
    const p = await prepare('SDM'),
      s = await start(p.id);
    await advance(p, s, step);
    expect(s.reply.comando.etapa).toBe(step);
    p.picc.respond(s.reply.comando.apduHex); // The tag applied it, but the HTTP response never arrived.
    expect((await interrupt(p, s)).alteracaoFisica).toBe('NAO_CONFIRMADA');
    expect(
      (await post(`${root}/${p.id}/encerramento`).send({ estacao: station }).expect(409)).body
        .codigo,
    ).toBe('NFC_RECUPERACAO_OBRIGATORIA');
    expect(
      (await post('/provisionamentos/' + p.link + '/encerramento').expect(409)).body.codigo,
    ).toBe('NFC_PERSONALIZACAO_PENDENTE');
    await post(`${root}/${p.id}/sessoes`)
      .send({ id: randomUUID(), sessaoRfId: randomUUID(), estacao: station, recuperar: true })
      .expect(400);
    const choices: MaterialChoice[] = versions.map((_, i) =>
      p.picc.keys
        .subarray(i * 16, i * 16 + 16)
        .equals(Buffer.from(p.targetKeys.subarray(i * 16, i * 16 + 16)))
        ? 'ALVO'
        : 'ATUAL',
    );
    const resets = p.picc.sdmCounterResets,
      mutations = p.picc.mutations.length;
    const recovery = await start(p.id, true, choices);
    await advance(p, recovery);
    expect(recovery.reply).toMatchObject({ status: 'CONCLUIDA', alteracaoFisica: 'CONFERIDA' });
    expect((await get(`${root}/${p.id}`).expect(200)).body.dados.plano).toEqual(p.op.plano);
    if (step === 'APLICAR_CONFIG_NDEF') {
      expect(p.picc.sdmCounterResets).toBe(resets);
      expect(p.picc.mutations).toHaveLength(mutations);
    }
    p.targetKeys.fill(0);
  });
  it('stops before any mutation on wrong credentials or UID; never probes another key', async () => {
    const p = await prepare(),
      s = await start(p.id);
    p.picc.keys[0] = p.picc.keys[0]! ^ 1;
    await advance(p, s);
    expect(s.reply.status).toBe('INTERROMPIDA');
    expect(s.reply.alteracaoFisica).toBe('NAO_ALTERADA');
    expect(p.picc.mutations).toHaveLength(0);
    p.picc.keys[0] = p.picc.keys[0]! ^ 1;
    const another = new SyntheticPersonalizationPicc(keys, versions, '04AABBCCDDEEFF');
    const recovery = await start(p.id, true, Array<MaterialChoice>(5).fill('ATUAL'));
    while (recovery.reply.comando)
      recovery.reply = (
        await respond(p.id, recovery, another.respond(recovery.reply.comando.apduHex)).expect(200)
      ).body.dados;
    expect(recovery.reply.codigo).toBe('NFC_ADMIN_UID_DIVERGENTE');
    expect(another.mutations).toHaveLength(0);
    p.targetKeys.fill(0);
  });
  it('replays HTTP after lost response with current checkpoint and one physical write', async () => {
    const p = await prepare(),
      s = await start(p.id);
    await advance(p, s, 'GRAVAR_NDEF_2');
    const raw = p.picc.respond(s.reply.comando.apduHex);
    const response = await respond(p.id, s, raw).expect(200),
      before = p.picc.mutations.length;
    const repeated = await respond(p.id, s, raw).expect(200);
    expect(repeated.body).toEqual(response.body);
    expect(p.picc.mutations).toHaveLength(before);
    expect((await respond(p.id, s, '9100').expect(409)).body.codigo).toBe(
      'NFC_IDEMPOTENCIA_CONFLITO',
    );
    s.reply = response.body.dados;
    await advance(p, s);
    expect(s.reply.status).toBe('CONCLUIDA');
    p.targetKeys.fill(0);
  });
  it('recovers after process restart without recreating the epoch material', async () => {
    const p = await prepare(),
      s = await start(p.id);
    await advance(p, s, 'TROCAR_CHAVE_0');
    p.picc.respond(s.reply.comando.apduHex);
    await app.close();
    app = await createHttpApplication(config, source, false, true);
    expect((await get(`${root}/${p.id}`).expect(200)).body.dados).toMatchObject({
      status: 'INTERROMPIDA',
      alteracaoFisica: 'NAO_CONFIRMADA',
    });
    const recovery = await start(p.id, true, Array<MaterialChoice>(5).fill('ALVO'));
    await advance(p, recovery);
    expect(recovery.reply.status).toBe('CONCLUIDA');
    p.targetKeys.fill(0);
  });
  it('does not replace an unused ended target under the same epoch', async () => {
    const p = await prepare('SDM');
    await post(`${root}/${p.id}/encerramento`).send({ estacao: station }).expect(200);
    // An ended unused target cannot be silently replaced under the same epoch.
    expect(
      (
        await post('/administracao-nfc/personalizacoes')
          .send({ ...p.body, id: randomUUID() })
          .expect(409)
      ).body.codigo,
    ).toBe('NFC_ALVO_EXISTENTE');
    p.targetKeys.fill(0);
  });
  it('fails closed when a programmatic lifecycle use case omits the administration adapter', async () => {
    const p = await prepare();
    await expect(
      new ActivateProvisioning(
        new TypeOrmUnitOfWork(source),
        new SystemClock(),
        new NodeIds(),
      ).execute(p.link, { bloqueioConfirmado: true }, randomUUID()),
    ).rejects.toMatchObject({ code: 'NFC_ADMINISTRACAO_INDISPONIVEL' });
    expect((await get('/provisionamentos/' + p.link).expect(200)).body.dados.status).toBe(
      'REGISTRADA',
    );
    p.targetKeys.fill(0);
  });
  it('refuses mutation after SDM evidence without resetting the counter or changing the target', async () => {
    const p = await prepare('SDM'),
      s = await start(p.id);
    await advance(p, s, 'LER_CONFIG_NDEF');
    await source.query('UPDATE sdm_counter_state SET maximum=7 WHERE provisioning_id=$1', [p.link]);
    s.reply = (
      await respond(p.id, s, p.picc.respond(s.reply.comando.apduHex)).expect(200)
    ).body.dados;
    expect(s.reply).toMatchObject({
      status: 'INTERROMPIDA',
      codigo: 'NFC_EPOCA_JA_UTILIZADA',
      alteracaoFisica: 'NAO_ALTERADA',
    });
    expect(p.picc.mutations).toHaveLength(0);
    expect(
      (
        await source.query('SELECT maximum FROM sdm_counter_state WHERE provisioning_id=$1', [
          p.link,
        ])
      )[0].maximum,
    ).toBe(7);
    p.targetKeys.fill(0);
  });
  it('recovers final SDM in verification-only mode even with a persisted counter, without any writes', async () => {
    const p = await prepare('SDM'),
      s = await start(p.id);
    await advance(p, s, 'APLICAR_CONFIG_NDEF');
    p.picc.respond(s.reply.comando.apduHex);
    await interrupt(p, s);
    await source.query('UPDATE sdm_counter_state SET maximum=9 WHERE provisioning_id=$1', [p.link]);
    const mutations = p.picc.mutations.length;
    const recovery = await start(p.id, true, Array<MaterialChoice>(5).fill('ALVO'));
    await advance(p, recovery);
    expect(recovery.reply.status).toBe('CONCLUIDA');
    expect(p.picc.mutations).toHaveLength(mutations);
    expect(p.picc.sdmCounterResets).toBe(1);
    expect(
      (
        await source.query('SELECT maximum FROM sdm_counter_state WHERE provisioning_id=$1', [
          p.link,
        ])
      )[0].maximum,
    ).toBe(9);
    p.targetKeys.fill(0);
  });
  it('does not rewrite an enabled SDM target when the operation lacks an authenticated byte proof', async () => {
    const p = await prepare('SDM'),
      s = await start(p.id);
    await interrupt(p, s);
    p.picc.keys.set(p.targetKeys);
    p.picc.versions.splice(0, 5, ...p.target.versions);
    p.picc.settings.set(2, Buffer.from(p.op.plano.personalizacao.configuracaoNdefFinalHex, 'hex'));
    const recovery = await start(p.id, true, Array<MaterialChoice>(5).fill('ALVO'));
    await advance(p, recovery);
    expect(recovery.reply).toMatchObject({
      status: 'INTERROMPIDA',
      codigo: 'NFC_PROVA_CONTEUDO_AUSENTE',
    });
    expect(p.picc.mutations).toHaveLength(0);
    expect((await store().run((tx) => tx.credential(uid)))!.id).toBe(p.current);
    p.targetKeys.fill(0);
  });
  it('serializes competing preparations and keeps exactly one target per pending epoch', async () => {
    const p = await prepare();
    await post(`${root}/${p.id}/encerramento`).send({ estacao: station }).expect(200);
    await post('/provisionamentos/' + p.link + '/encerramento').expect(200);
    const next = (
      await post('/etiquetas')
        .send({ pedidoId: p.order, uid, modelo: 'NTAG424DNA', estrategia: 'UID' })
        .expect(201)
    ).body.dados.id as string;
    const replies = await Promise.all(
      [randomUUID(), randomUUID()].map((id) =>
        post('/administracao-nfc/personalizacoes').send({
          id,
          provisionamentoId: next,
          estacao: station,
        }),
      ),
    );
    expect(replies.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(
      (
        await source.query(
          'SELECT count(*)::int AS n FROM nfc_personalization_targets WHERE provisioning_id=$1',
          [next],
        )
      )[0].n,
    ).toBe(1);
    const winner = replies.find((r) => r.status === 201)!.body.dados;
    expect(winner.plano.epoca).toBe(2);
    expect(winner.plano.personalizacao.referenciaAlvo).not.toBe(p.target.id);
    await expect(
      source.query(
        'UPDATE nfc_personalization_targets SET credential_id=$1 WHERE provisioning_id=$2',
        [p.target.id, next],
      ),
    ).rejects.toThrow();
    p.targetKeys.fill(0);
  });
  it('commits command intent, checkpoint and outbox together; lost process state requires fresh RF', async () => {
    const p = await prepare();
    let reject = false;
    const failing: AdministrationStore = {
      run: (work) =>
        store().run((tx) =>
          work({
            ...tx,
            authorize: tx.authorize.bind(tx),
            lockUid: tx.lockUid.bind(tx),
            credential: tx.credential.bind(tx),
            importCredential: tx.importCredential.bind(tx),
            insertCredential: tx.insertCredential.bind(tx),
            credentialById: tx.credentialById.bind(tx),
            bindTarget: tx.bindTarget.bind(tx),
            targetOperation: tx.targetOperation.bind(tx),
            promoteTarget: tx.promoteTarget.bind(tx),
            credentialsForRewrap: tx.credentialsForRewrap.bind(tx),
            appendWrapper: tx.appendWrapper.bind(tx),
            openByUid: tx.openByUid.bind(tx),
            provisioning: tx.provisioning.bind(tx),
            operation: tx.operation.bind(tx),
            saveOperation: tx.saveOperation.bind(tx),
            session: tx.session.bind(tx),
            saveSession: tx.saveSession.bind(tx),
            response: tx.response.bind(tx),
            saveResponse: tx.saveResponse.bind(tx),
            append: tx.append.bind(tx),
            journal: tx.journal.bind(tx),
            publish: async (e) => {
              if (reject) throw Error('Injected outbox failure');
              await tx.publish(e);
            },
          }),
        ),
    };
    const gateway = new Ev2AdministrationGateway(vault),
      service = new NfcAdministration(
        failing,
        gateway,
        new SystemClock(),
        new NodeIds(),
        new Sha256Fingerprint(),
        180,
        new NodeTargetGenerator(vault, (id, t) => sdm.unseal(id, t, t.sealed)),
      );
    const actor = { userId: user.id, sessionId: user.sessionId, role: user.role },
      sessionId = randomUUID(),
      rfSessionId = randomUUID();
    let reply: SessionReply = await service.begin(
      p.id,
      { id: sessionId, rfSessionId, station, recovery: false },
      actor,
    );
    try {
      while (reply.command && reply.command.step !== 'LER_CONFIG_NDEF')
        reply = await service.respond(
          p.id,
          sessionId,
          {
            commandId: reply.command.id,
            rfSessionId,
            station,
            responseHex: p.picc.respond(reply.command.apduHex),
          },
          actor,
        );
      const before = (await store().run((tx) => tx.operation(p.id)))!,
        receipt = reply.command!;
      reject = true;
      await expect(
        service.respond(
          p.id,
          sessionId,
          {
            commandId: receipt.id,
            rfSessionId,
            station,
            responseHex: p.picc.respond(receipt.apduHex),
          },
          actor,
        ),
      ).rejects.toThrow('Injected outbox failure');
      expect(await store().run((tx) => tx.operation(p.id))).toEqual(before);
      expect(await store().run((tx) => tx.response(receipt.id))).toBeNull();
      expect(p.picc.mutations).toHaveLength(0);
      reject = false;
      expect((await service.get(p.id, actor)).state).toBe('INTERROMPIDA');
    } finally {
      gateway.closeAll();
      p.targetKeys.fill(0);
    }
  });
  it('rewraps CURRENT and TARGET credentials atomically without changing references or physical keys', async () => {
    const p = await prepare('SDM');
    const before = await store().run((tx) => tx.operation(p.id));
    const second = randomBytes(32).toString('base64'),
      ring = { ...(JSON.parse(masters) as Record<string, string>), '2': second };
    const newer = new NodeCredentialVault('2', JSON.stringify(ring)),
      onlyNew = new NodeCredentialVault('2', JSON.stringify({ '2': second }));
    try {
      let wrapped = 0;
      const broken: CredentialVault = {
        seal: newer.seal.bind(newer),
        unseal: newer.unseal.bind(newer),
        rewrap: (r) => {
          if (++wrapped === 2) throw Error('Injected second wrapper failure');
          return newer.rewrap(r);
        },
      };
      const outboxBefore = (await source.query('SELECT count(*)::int AS n FROM outbox'))[0].n;
      await expect(
        new RewrapNfcInventory(store(), broken, new SystemClock(), new NodeIds()).execute(),
      ).rejects.toThrow('Injected second wrapper failure');
      expect(
        (await source.query('SELECT count(*)::int AS n FROM nfc_credential_wrappers'))[0].n,
      ).toBe(0);
      expect((await source.query('SELECT count(*)::int AS n FROM outbox'))[0].n).toBe(outboxBefore);
      const output = execFileSync(
        process.execPath,
        ['-r', 'ts-node/register', 'src/platform/access/nfc-inventory-cli.ts', 'rewrap'],
        {
          encoding: 'utf8',
          windowsHide: true,
          env: {
            ...process.env,
            DATABASE_URL: 'url' in source.options ? source.options.url : undefined,
            SDM_ACTIVE_MASTER_VERSION: '2',
            SDM_MASTER_KEYS_JSON: JSON.stringify(ring),
          },
        },
      );
      expect(JSON.parse(output)).toEqual({
        envelopesRotacionados: 2,
        chavesFisicasAlteradas: false,
      });
      expect(output).not.toContain(Buffer.from(p.targetKeys.subarray(0, 16)).toString('hex'));
      const records = await store().run(async (tx) => [
        await tx.credentialById(p.current),
        await tx.credentialById(p.target.id),
      ]);
      expect(records.map((r) => r!.sealed.masterVersion)).toEqual(['2', '2']);
      expect(Buffer.from(onlyNew.unseal(records[0]!))).toEqual(keys);
      expect(Buffer.from(onlyNew.unseal(records[1]!))).toEqual(Buffer.from(p.targetKeys));
      expect((await store().run((tx) => tx.credential(uid)))!.id).toBe(p.current);
      expect(await store().run((tx) => tx.operation(p.id))).toEqual(before);
      expect(
        (await source.query('SELECT count(*)::int AS n FROM nfc_credential_wrappers'))[0].n,
      ).toBe(2);
      await expect(
        source.query("UPDATE nfc_credential_wrappers SET sealed='{}'"),
      ).rejects.toThrow();
      // A missing old master aborts ALL wrappers and audit effects.
      const missing = new NodeCredentialVault(
        '3',
        JSON.stringify({ '3': randomBytes(32).toString('base64') }),
      );
      try {
        await expect(
          new RewrapNfcInventory(store(), missing, new SystemClock(), new NodeIds()).execute(),
        ).rejects.toThrow();
      } finally {
        missing.close();
      }
      expect(
        (await source.query('SELECT count(*)::int AS n FROM nfc_credential_wrappers'))[0].n,
      ).toBe(2);
    } finally {
      newer.close();
      onlyNew.close();
      p.targetKeys.fill(0);
    }
  });
});
