const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { randomBytes, randomUUID, createHash, createCipheriv } = require('node:crypto');
const { createHttpApplication } = require('../src/bootstrap/application');
const { readConfig } = require('../src/bootstrap/config');
const { createDataSource } = require('../src/platform/database/data-source');
const { resetDatabase, seedIdentity, testPassword } = require('./support');
const { SyntheticPersonalizationPicc } = require('./nfc-personalization-picc');
const {
  ImportNfcInventory,
} = require('../src/bounded-contexts/tag-administration/application/administration-service');
const {
  PostgresAdministrationStore,
} = require('../src/bounded-contexts/tag-administration/infrastructure/postgres-administration-store');
const {
  NodeCredentialVault,
} = require('../src/bounded-contexts/tag-administration/infrastructure/credential-vault');
const { SystemClock, NodeIds } = require('../src/platform/runtime');
const {
  deriveSdmKey,
  aesCmac,
  truncateSdmMac,
} = require('../src/bounded-contexts/traceability/infrastructure/sdm-crypto');

function connection(db) {
  let tail = Promise.resolve();
  const sql = {
    exec: async (text) => {
      db.exec(text);
    },
    run: async (text, params = []) => ({
      changes: Number(db.prepare(text).run(...params).changes),
    }),
    first: async (text, params = []) => db.prepare(text).get(...params) ?? null,
    all: async (text, params = []) => db.prepare(text).all(...params),
    transaction: (work) => {
      const result = tail.then(async () => {
        db.exec('BEGIN IMMEDIATE');
        try {
          const value = await work(sql);
          db.exec('COMMIT');
          return value;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      });
      tail = result.then(
        () => {},
        () => {},
      );
      return result;
    },
  };
  return sql;
}

async function runContract({ compiled, folder, databaseUrl, check }) {
  let phase = 'load-mobile-modules';
  const load = (file) => require(path.join(compiled, file));
  const { AdministrationCoordinator } = load('appplication/administration/coordinator');
  const { SqliteAdministrationStore } = load('infra/administration/sqlite-store');
  const { SessionManager } = load('appplication/auth/session-manager');
  const { HttpTransport } = load('infra/auth/http-transport');
  const { SessionError } = load('domain/auth/types');
  const { OfflineCoordinator } = load('appplication/offline/coordinator');
  const { SqliteCaptureStore } = load('infra/offline/sqlite-store');
  const { TraceabilityWorkflow } = load('appplication/traceability/workflow');
  check(
    new URL(databaseUrl).pathname === '/nfc_mobile_contract_test',
    'Refuse a non-contract database.',
  );
  const masters = JSON.stringify({ 1: randomBytes(32).toString('base64') });
  const vault = new NodeCredentialVault('1', masters);
  const source = createDataSource(databaseUrl);
  const config = readConfig({
    DATABASE_URL: databaseUrl,
    APP_PROCESS_ROLE: 'api',
    SDM_ACTIVE_MASTER_VERSION: '1',
    SDM_MASTER_KEYS_JSON: masters,
  });
  let app, baseUrl, port;
  const cases = [];
  let latestMetrics;
  const databases = new Set();
  function openDatabase(filename) {
    const db = new DatabaseSync(path.join(folder, filename));
    databases.add(db);
    return { db, sql: connection(db) };
  }
  function closeDatabase(db) {
    db.close();
    databases.delete(db);
  }
  async function startServer() {
    app = await createHttpApplication(config, source, false, true);
    await app.listen(port ?? 0, '127.0.0.1');
    port = app.getHttpServer().address().port;
    baseUrl = `http://127.0.0.1:${port}/api/v1`;
  }
  async function restartServer() {
    await app.close();
    await startServer();
  }
  async function fixture(strategy, scenario) {
    phase = scenario + ' reset-and-login';
    await resetDatabase(source);
    const account = await seedIdentity(source);
    let savedSession = null,
      fault = async () => {},
      apiCalls = 0;
    const fetcher = async (url, options) => {
      apiCalls++;
      await fault('before', url, options);
      const response = await fetch(url, options);
      await fault('after', url, options, response);
      return response;
    };
    const sessionManager = new SessionManager(
      {
        load: async () => savedSession,
        save: async (value) => {
          savedSession = value;
        },
        clear: async () => {
          savedSession = null;
        },
      },
      new HttpTransport(fetcher),
      true,
    );
    await sessionManager.login(baseUrl, account.login, testPassword);
    phase = scenario + ' prepare-journal';
    const context = async () => {
      const s = sessionManager.getSnapshot();
      check(s.status === 'authenticated', 'Administrator must remain authenticated.');
      check(
        s.session.user.perfil === 'ADMINISTRADOR',
        'Contract context must retain the administrative role.',
      );
      return {
        baseUrl,
        userId: s.session.user.id,
        station: 'synthetic-mobile-contract',
        sessionMarker: createHash('sha256').update(s.session.token).digest('hex'),
      };
    };
    const owner = await context();
    let local = openDatabase(`${scenario}-administration.db`);
    let store = new SqliteAdministrationStore(async () => local.sql);
    const uid = '04112233445566',
      versions = [0, 0, 0, 0, 0],
      keys = randomBytes(80);
    const picc = new SyntheticPersonalizationPicc(keys, versions, uid);
    await new ImportNfcInventory(
      new PostgresAdministrationStore(source),
      vault,
      new SystemClock(),
      new NodeIds(),
    ).execute(uid, versions, keys);
    keys.fill(0);
    const transports = new Map(),
      transmittedStages = [],
      rfIds = [],
      attempts = new Map();
    let publicReading = (value) => value;
    let stage = '',
      interruptStage = null,
      readCounter = 0,
      activationReads = 0,
      afterPhysical = async () => {};
    const nfc = {
      cancel: async () => {},
      run: async (_op, work) => {
        const rfId = randomUUID();
        rfIds.push(rfId);
        return work({
          id: rfId,
          checkpoint: () => {},
          transceive: async (bytes) => {
            const hex = Buffer.from(bytes).toString('hex').toUpperCase();
            const row = local.db
              .prepare(
                "SELECT command_id,frame,state FROM admin_commands WHERE state='ATTEMPTED' ORDER BY rowid DESC LIMIT 1",
              )
              .get();
            check(
              row && JSON.parse(row.frame).apduHex === hex,
              'Physical transport must have a durable matching intent.',
            );
            check(
              !transports.has(row.command_id),
              'A command id must never be physically replayed.',
            );
            transports.set(row.command_id, rfId);
            transmittedStages.push(stage);
            attempts.set(stage, (attempts.get(stage) ?? 0) + 1);
            const response = picc.respond(hex);
            await afterPhysical(stage);
            if (stage === interruptStage) {
              interruptStage = null;
              throw new SessionError('NFC_TAG_LOST', 'Synthetic RF loss after mutation.');
            }
            return [...Buffer.from(response, 'hex')];
          },
        });
      },
      read: async () => {
        activationReads++;
        return publicReading(reading());
      },
    };
    let coordinator = new AdministrationCoordinator(
      sessionManager,
      store,
      nfc,
      context,
      randomUUID,
    );
    const order = await sessionManager.request('/pedidos', {
      method: 'POST',
      body: { codigo: 'SYNTHETIC-' + randomUUID() },
    });
    const link = await coordinator.register(order.id, uid, strategy, 'ESTRITA');
    let operation = await coordinator.prepare(link);
    phase = scenario + ' execute-and-activate';
    const targetReference = operation.plano.personalizacao.referenciaAlvo;
    const progress = (value) => {
      stage = value.stage;
    };
    function reading() {
      const image = Buffer.from(picc.files.get(2));
      const length = image.readUInt16BE(0),
        wire = Buffer.from(image.subarray(2, 2 + length));
      let ndef = length ? wire.subarray(5).toString('ascii') : undefined;
      if (strategy === 'SDM') {
        check(
          (picc.settings.get(2)[1] & 0x40) !== 0,
          'Public SDM read requires the installed final settings.',
        );
        readCounter++;
        const ctr = Buffer.alloc(3);
        ctr.writeUIntLE(readCounter, 0, 3);
        const plain = Buffer.concat([
          Buffer.from([0xc7]),
          Buffer.from(uid, 'hex'),
          ctr,
          randomBytes(5),
        ]);
        const cipher = createCipheriv('aes-128-cbc', picc.keys.subarray(16, 32), Buffer.alloc(16));
        cipher.setAutoPadding(false);
        const encoded = Buffer.concat([cipher.update(plain), cipher.final()])
          .toString('hex')
          .toUpperCase();
        Buffer.from(encoded, 'ascii').copy(wire, 75 - 2);
        const sessionKey = deriveSdmKey(picc.keys.subarray(32, 48), Buffer.from(uid, 'hex'), ctr);
        const mac = truncateSdmMac(aesCmac(sessionKey, wire.subarray(7 - 2, 113 - 2)))
          .toString('hex')
          .toUpperCase();
        sessionKey.fill(0);
        Buffer.from(mac, 'ascii').copy(wire, 113 - 2);
        ndef = wire.subarray(5).toString('ascii');
      }
      return { uid, ...(ndef !== undefined ? { ndef } : {}), bytesBase64: wire.toString('base64') };
    }
    async function execute(materials = Array(5).fill('ATUAL')) {
      operation = await coordinator.execute(operation, materials, progress);
      return operation;
    }
    async function recover(materials) {
      operation = await coordinator.restore(await coordinator.refresh(operation.id));
      check(
        operation.plano.personalizacao.referenciaAlvo === targetReference,
        'Recovery must conserve the same target.',
      );
      const suggestions = await coordinator.suggestions(operation);
      if (materials) await execute(materials);
      return suggestions;
    }
    async function reopen() {
      closeDatabase(local.db);
      local = openDatabase(`${scenario}-administration.db`);
      store = new SqliteAdministrationStore(async () => local.sql);
      coordinator = new AdministrationCoordinator(sessionManager, store, nfc, context, randomUUID);
    }
    async function assertVerified() {
      const record = await new PostgresAdministrationStore(source).run((tx) =>
          tx.credentialById(targetReference),
        ),
        target = vault.unseal(record);
      try {
        check(
          picc.keys.equals(Buffer.from(target)),
          'All physical synthetic keys must match the original server target.',
        );
      } finally {
        target.fill(0);
      }
      check(
        picc.versions.every((version, i) => version === record.versions[i]),
        'All installed versions must match.',
      );
      check(
        operation.alteracaoFisica === 'CONFERIDA',
        'The server must have conferred the entire plan.',
      );
      const pending = await sessionManager.request('/provisionamentos/' + link.id);
      check(pending.status === 'REGISTRADA', 'Personalization alone must not activate the link.');
      check(
        (await coordinator.localJournal(operation)).every(
          (item) =>
            item.state === 'ACKNOWLEDGED' ||
            item.state === 'ATTEMPTED' ||
            item.state === 'READY' ||
            item.state === 'RESPONSE',
        ),
        'Local journal must be readable.',
      );
    }
    const fixtureResult = {
      sessionManager,
      context,
      owner,
      link,
      order,
      picc,
      progress,
      execute,
      recover,
      reopen,
      reading,
      assertVerified,
      coordinator: () => coordinator,
      operation: () => operation,
      setFault: (value) => {
        fault = value;
      },
      interruptAt: (value) => {
        interruptStage = value;
      },
      afterPhysical: (value) => {
        afterPhysical = value;
      },
      publicReading: (value) => {
        publicReading = value;
      },
      local: () => local,
      stage: () => stage,
      metrics: () => ({
        rfSessions: rfIds.length,
        commands: transports.size,
        activationReads,
        sdmResets: picc.sdmCounterResets,
        attempts: Object.fromEntries(attempts),
        apiCalls,
      }),
      rfIds,
    };
    latestMetrics = fixtureResult.metrics;
    return fixtureResult;
  }
  async function run(name, job) {
    await job();
    cases.push({ name, status: 'PASS', syntheticTransport: latestMetrics?.() });
    process.stdout.write('PASS: ' + name + '\n');
  }
  try {
    await source.initialize();
    await source.runMigrations({ transaction: 'all' });
    await startServer();
    for (const strategy of ['UID', 'NDEF_ESTATICO', 'SDM'])
      await run('full-cycle-' + strategy, async () => {
        const f = await fixture(strategy, 'cycle-' + strategy);
        await f.execute();
        await f.assertVerified();
        const active = await f.coordinator().activate(f.operation(), f.link, true);
        check(active.status === 'ATIVA', 'Fresh-session activation must succeed.');
        check(f.metrics().activationReads === 1, 'Activation must use a separate public read.');
        await f.coordinator().end(f.operation());
        const q = openDatabase('cycle-' + strategy + '-captures.db'),
          captureStore = new SqliteCaptureStore(async () => q.sql);
        let canSend = true;
        const workflow = new TraceabilityWorkflow(f.sessionManager);
        let offline = new OfflineCoordinator(
          captureStore,
          () => ({ ...f.owner, canCapture: true, canSend }),
          f.sessionManager,
          (r) => workflow.resolveProvisioning(r),
          randomUUID,
        );
        await offline.remember(f.reading());
        canSend = false;
        for (const type of ['COLETA', 'MOVIMENTACAO', 'RECEBIMENTO', 'EXPEDICAO', 'ENTREGA'])
          await offline.capture(
            f.reading(),
            type,
            randomUUID(),
            new Date().toISOString(),
            'synthetic-phone',
          );
        const pending = await captureStore.list(f.owner);
        check(
          pending.length === 5 && pending.every((item) => item.state === 'QUEUED'),
          'Offline captures must be durable before synchronization.',
        );
        const before = f.metrics().apiCalls;
        await offline.synchronize();
        check(f.metrics().apiCalls === before, 'Offline synchronization must not perform HTTP.');
        closeDatabase(q.db);
        const restarted = openDatabase('cycle-' + strategy + '-captures.db'),
          resumedStore = new SqliteCaptureStore(async () => restarted.sql);
        canSend = true;
        offline = new OfflineCoordinator(
          resumedStore,
          () => ({ ...f.owner, canCapture: true, canSend }),
          f.sessionManager,
          (r) => workflow.resolveProvisioning(r),
          randomUUID,
        );
        await offline.synchronize();
        const settled = await resumedStore.list(f.owner);
        check(
          settled.length === 5 &&
            settled.every((item) => item.state === 'STORED' && item.receipt.decisao.autorizada),
          'All five events must be accepted after reopen/sync.',
        );
        check(
          (await workflow.order(f.order.id)).estado === 'ENTREGUE',
          'The order must reach ENTREGUE.',
        );
        const history = await workflow.history(f.order.id, 1, f.link.id);
        check(history.itens.length === 6, 'The six event types must appear in history.');
        for (const item of settled)
          await f.sessionManager.request('/eventos', { method: 'POST', body: item.payload });
        check(
          (await workflow.history(f.order.id, 1, f.link.id)).itens.length === 6,
          'HTTP replay must not duplicate movement/history.',
        );
        check(
          f.metrics().sdmResets === (strategy === 'SDM' ? 1 : 0),
          'SDM must not be reset twice.',
        );
      });
    await run('verified-operation-ended-before-activation', async () => {
      const f = await fixture('UID', 'ended-verified');
      await f.execute();
      await f.assertVerified();
      const ended = await f.coordinator().end(f.operation());
      check(
        ended.status === 'ENCERRADA' && ended.alteracaoFisica === 'CONFERIDA',
        'Ending a verified operation must preserve the conferred physical outcome.',
      );
      check(
        (await f.sessionManager.request('/provisionamentos/' + f.link.id)).status === 'REGISTRADA',
        'Ending administration must not activate or close the registered link.',
      );
      const commands = f.metrics().commands;
      const active = await f.coordinator().activate(ended, f.link, true);
      check(
        active.status === 'ATIVA' &&
          f.metrics().commands === commands &&
          f.metrics().activationReads === 1,
        'A separately ended verified operation must still allow one fresh activation without configuration commands.',
      );
    });
    await run('unconfigured-plan-ended-and-new-epoch-prepared', async () => {
      const f = await fixture('UID', 'ended-unconfigured');
      const ended = await f.coordinator().end(f.operation());
      check(
        ended.status === 'ENCERRADA' && !ended.alteracaoEmitida && f.metrics().commands === 0,
        'Ending an unconfigured plan must not send NFC commands.',
      );
      const registered = await f.sessionManager.request('/provisionamentos/' + f.link.id);
      check(registered.status === 'REGISTRADA', 'The unconfigured link must remain registered.');
      const preserved = await f.coordinator().prepare(registered);
      check(
        preserved.id === ended.id &&
          preserved.status === 'ENCERRADA' &&
          preserved.plano.personalizacao.referenciaAlvo ===
            ended.plano.personalizacao.referenciaAlvo,
        'Preparing the same link must return its ended original target, never silently reopen it.',
      );
      let refused = false;
      try {
        await f.coordinator().activate(ended, registered, true);
      } catch (error) {
        refused = error.code === 'ADMIN_ATIVACAO_PENDENTE';
      }
      check(
        refused && f.metrics().activationReads === 0,
        'An unconfigured ended plan cannot authorize activation.',
      );
      let refusedByApi = false;
      try {
        await f.sessionManager.request('/provisionamentos/' + registered.id + '/ativacao', {
          method: 'POST',
          body: { bloqueioConfirmado: true },
        });
      } catch (error) {
        refusedByApi = error.code === 'NFC_PERSONALIZACAO_PENDENTE';
      }
      check(
        refusedByApi,
        'The API must refuse activation even if a caller declares physical confirmation.',
      );
      await new TraceabilityWorkflow(f.sessionManager).closeProvisioning(
        registered,
        f.owner.userId,
      );
      const next = await f.coordinator().register(f.order.id, f.link.uid, 'UID', 'ESTRITA');
      const nextPlan = await f.coordinator().prepare(next);
      check(
        next.epoca === f.link.epoca + 1 &&
          nextPlan.status === 'PREPARADA' &&
          nextPlan.plano.personalizacao.referenciaAlvo !==
            ended.plano.personalizacao.referenciaAlvo,
        'Explicit link closure and reuse must create a new epoch/target while preserving the old plan.',
      );
      check(
        (await f.coordinator().refresh(ended.id)).status === 'ENCERRADA' &&
          f.metrics().commands === 0,
        'Preparing a new epoch must leave the prior history intact and perform no NFC commands.',
      );
    });
    await run('http-reply-loss-after-key-0-commit', async () => {
      const f = await fixture('SDM', 'http-loss');
      let injected = false;
      f.setFault(async (phase, url, _options, response) => {
        if (
          phase === 'after' &&
          url.endsWith('/respostas') &&
          f.stage() === 'TROCAR_CHAVE_0' &&
          !injected
        ) {
          injected = true;
          await response.text();
          throw Error('Synthetic lost response after commit.');
        }
      });
      await f.execute();
      await f.assertVerified();
      check(injected, 'The intended key-0 HTTP fault must occur.');
      check(f.metrics().attempts.TROCAR_CHAVE_0 === 1, 'Key 0 cannot be sent twice on HTTP retry.');
    });
    await run('physical-key-0-ack-loss-and-explicit-recovery', async () => {
      const f = await fixture('SDM', 'rf-loss');
      f.interruptAt('TROCAR_CHAVE_0');
      let lost = false;
      try {
        await f.execute();
      } catch (error) {
        lost = error.code === 'NFC_TAG_LOST';
      }
      check(lost, 'The physical ACK fault must interrupt the job.');
      const choices = await f.recover();
      check(
        choices[0] === null && choices.slice(1).every((x) => x === 'ALVO'),
        'Unknown key 0 must require explicit material selection.',
      );
      await f.recover(Array(5).fill('ALVO'));
      await f.assertVerified();
      check(
        f.rfIds.length === 2 && new Set(f.rfIds).size === 2,
        'Recovery must open a new RF identity.',
      );
    });
    await run('network-outage-sqlite-reopen-http-only-restoration', async () => {
      const f = await fixture('SDM', 'reopen');
      f.setFault(async (phase, url) => {
        if (
          phase === 'before' &&
          f.stage() === 'TROCAR_CHAVE_0' &&
          (url.endsWith('/respostas') || url.endsWith('/interrupcao'))
        )
          throw Error('Synthetic offline network.');
      });
      let stopped = false;
      try {
        await f.execute();
      } catch {
        stopped = true;
      }
      check(stopped, 'The offline network must stop the job.');
      await f.reopen();
      f.setFault(async () => {});
      const commands = f.metrics().commands,
        choices = await f.recover();
      check(f.metrics().commands === commands, 'Restore must perform no physical commands.');
      check(
        choices.every((x) => x === 'ALVO'),
        'Saved key-0 reply must recover its original receipt.',
      );
      await f.recover(choices);
      await f.assertVerified();
    });
    await run('server-restart-after-key-0-with-immutable-target', async () => {
      const f = await fixture('SDM', 'server-restart');
      let restarted = false;
      f.setFault(async (phase, url) => {
        if (
          phase === 'before' &&
          url.endsWith('/respostas') &&
          f.stage() === 'TROCAR_CHAVE_0' &&
          !restarted
        ) {
          restarted = true;
          await restartServer();
        }
      });
      let stopped = false;
      try {
        await f.execute();
      } catch {
        stopped = true;
      }
      check(stopped && restarted, 'A lost backend EV2 channel must interrupt the job.');
      f.setFault(async () => {});
      await f.recover(Array(5).fill('ALVO'));
      await f.assertVerified();
    });
    await run('login-change-preserves-late-key-0-response', async () => {
      const f = await fixture('SDM', 'login-change');
      let changed = false;
      f.afterPhysical(async (stage) => {
        if (stage === 'TROCAR_CHAVE_0' && !changed) {
          changed = true;
          const s = f.sessionManager.getSnapshot();
          await f.sessionManager.login(baseUrl, s.session.user.login, testPassword);
        }
      });
      let stopped = false;
      try {
        await f.execute();
      } catch (error) {
        stopped = error.code === 'ADMIN_SESSAO_ALTERADA';
      }
      check(stopped && changed, 'Changing login must stop the old RF.');
      const commands = f
        .local()
        .db.prepare("SELECT frame,response_hex FROM admin_commands WHERE state='RESPONSE'")
        .all();
      check(
        commands.some(
          (row) => JSON.parse(row.frame).etapa === 'TROCAR_CHAVE_0' && row.response_hex === '9100',
        ),
        'Late key-0 response must remain durably saved.',
      );
      const choices = await f.recover();
      check(choices[0] === null, 'New login must not submit an old RF reply.');
      await f.recover(Array(5).fill('ALVO'));
      await f.assertVerified();
    });
    await run('final-sdm-ack-loss-is-verification-only', async () => {
      const f = await fixture('SDM', 'final-sdm-loss');
      f.interruptAt('APLICAR_CONFIG_NDEF');
      let lost = false;
      try {
        await f.execute();
      } catch (error) {
        lost = error.code === 'NFC_TAG_LOST';
      }
      check(lost, 'The final SDM ACK fault must interrupt the job.');
      const mutations = f.picc.mutations.length;
      check(
        f.picc.sdmCounterResets === 1,
        'The final SDM settings must have reached the synthetic chip.',
      );
      await f.recover(Array(5).fill('ALVO'));
      await f.assertVerified();
      check(
        f.picc.mutations.length === mutations && f.picc.sdmCounterResets === 1,
        'Recovery of installed SDM must be verification-only, without writes or resets.',
      );
    });
    await run('activation-response-loss-preserves-same-public-evidence', async () => {
      const f = await fixture('SDM', 'activation-loss');
      await f.execute();
      let lost = false;
      f.setFault(async (phase, url, _options, response) => {
        if (phase === 'after' && url.endsWith('/ativacao') && !lost) {
          lost = true;
          await response.text();
          throw Error('Synthetic lost activation reply.');
        }
      });
      const active = await f.coordinator().activate(f.operation(), f.link, true);
      check(
        active.status === 'ATIVA' && lost,
        'A lost activation reply must recover the exact committed link.',
      );
      await f.coordinator().activate(f.operation(), f.link, true);
      check(
        f.metrics().activationReads === 1,
        'Activation receipt replay must not read the tag again.',
      );
      const rows = await source.query('SELECT count(*)::int AS count FROM sdm_evidence');
      check(rows[0].count === 1, 'The activation evidence must be reserved exactly once.');
    });
    await run('invalid-sdm-activation-preserved-before-new-reading', async () => {
      const f = await fixture('SDM', 'invalid-activation');
      await f.execute();
      f.publicReading((reading) => {
        const ndef = reading.ndef.slice(0, -1) + (reading.ndef.endsWith('0') ? '1' : '0');
        const wire = Buffer.from(reading.bytesBase64, 'base64');
        Buffer.from(ndef, 'ascii').copy(wire, 5);
        return { ...reading, ndef, bytesBase64: wire.toString('base64') };
      });
      let invalid = false;
      try {
        await f.coordinator().activate(f.operation(), f.link, true);
      } catch (error) {
        invalid = error.code === 'SDM_ATIVACAO_INVALIDA';
      }
      check(invalid, 'The server must reject a structurally valid but forged SDM MAC.');
      check(
        !(await f.coordinator().activationPending(f.operation())),
        'Definitively rejected evidence cannot permanently occupy the pending activation.',
      );
      check(
        (await source.query('SELECT count(*)::int AS count FROM sdm_evidence'))[0].count === 0,
        'Rejected SDM must not reserve a counter.',
      );
      f.publicReading((value) => value);
      const active = await f.coordinator().activate(f.operation(), f.link, true);
      check(active.status === 'ATIVA', 'A fresh valid reading must activate the same link.');
      const rows = f
        .local()
        .db.prepare('SELECT rejection_code,receipt FROM admin_activation ORDER BY sequence')
        .all();
      check(
        rows.length === 2 &&
          rows[0].rejection_code === 'SDM_ATIVACAO_INVALIDA' &&
          rows[1].receipt !== null,
        'Rejected and accepted activation evidence must both remain in the local journal.',
      );
      check(
        f.metrics().activationReads === 2,
        'Definitive rejection must be followed by a fresh public read.',
      );
    });
    return {
      cases,
      postgresMigrations: (await source.query('SELECT count(*)::int AS count FROM migrations'))[0]
        .count,
      transport: 'HTTP_LOOPBACK_REAL',
      administrationDatabase: 'SQLITE_WAL_FULL_REAL',
      tag: 'PICC_SINTETICA_COM_ESTADO',
      nfcTimings: null,
    };
  } catch (error) {
    if (!/^CONTRACT: /.test(error.message))
      throw Error(
        `CONTRACT: phase ${phase} failed (${error.code ?? error.name ?? 'UNKNOWN'}); private values omitted.`,
      );
    throw error;
  } finally {
    for (const db of databases) closeDatabase(db);
    vault.close();
    await app?.close();
    if (source.isInitialized) await source.destroy();
  }
}
module.exports = { runContract };
