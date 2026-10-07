# Reconciliação e decisões rastreáveis — #6

Entrega de software na branch `codex/issue-6-event-reconciliation`, sobre #5.
Não exige NTAG 424 DNA. Mensagens SDM dos testes são fixtures sintéticas;
administração e aceite NFC físicos continuam em #12.

## Regras e limites

Somente uma leitura identificada, elegível pela estratégia original e enviada
por identidade verificada pode aguardar uma etapa futura. A operação ainda não
movimenta o pedido. Evidência inválida, vínculo desconhecido/inativo, evento
reservado e etapas já ultrapassadas recebem rejeição definitiva.

| Operação | Estado ao chegar | Antecedentes necessários |
| --- | --- | --- |
| RECEBIMENTO | CADASTRADO | COLETA → COLETADO |
| MOVIMENTACAO | CADASTRADO | COLETA → COLETADO |
| EXPEDICAO ou ENTREGA | CADASTRADO | COLETA → COLETADO; RECEBIMENTO → RECEBIDO |
| EXPEDICAO ou ENTREGA | COLETADO | RECEBIMENTO → RECEBIDO |

As demais regras permanecem na máquina de estados: expedição única, movimentação
repetível, entrega sem expedição obrigatória e PROVISIONAMENTO exclusivo da ativação.
Capturas posteriores à entrega não voltam etapas. Uma pendência que perde sua janela
de estado, inclusive porque outra captura já entregou o pedido, termina rejeitada.

O prazo é o menor entre **recebimento + 24 horas** e **expiração da sessão que enviou
a captura ao servidor**. O relógio declarado pelo aparelho não determina prazo nem
ordena transições. Logout, revogação/desativação ou perda de permissão da identidade
original encerram a pendência; uma sessão nova não substitui a autoria da pendência.
Nova captura requer nova ação e UUID. Comandos internos sem autoria autenticada não
criam pendências. A fronteira HTTP continua exigindo sessão e perfil permitido.

Vínculo, estratégia e época são os originais. Encerramento rejeita a pendência da
época antiga; reutilizar UID em outro pedido não a transfere. UID/NDEF continuam
reutilizáveis entre capturas. Divergência de UID no tratamento NDEF mantém SUSPEITO
e seu aviso, sem trocar a estratégia.

SDM só aguarda logística se a primeira avaliação autenticou evidência **NOVA**.
O reconciliador confere a propriedade da reserva `(provisionamento, contador, UUID)`;
não verifica novamente chaves, não avança o máximo e não consome outro contador.
Uma captura inicialmente tardia permanece TARDIA sem movimento automático nas duas
políticas. Reutilização por outro UUID permanece rejeitada, mesmo se a sequência
logística depois se tornar válida. Isso não comprova frescor nem verdade física.

## Durabilidade e ordem

Observação e tabela `decisions` mantêm o recibo original imutável. Cada nova decisão
é inserida em `decision_revisions`; `current_decisions` aponta a revisão atual.
Triggers bloqueiam edição/exclusão do histórico, retrocesso da projeção e mudança
de decisão terminal. A migration cria revisão 1 dos registros da v1 sem mudar seus
recibos ou tornar rejeições antigas pendentes retrospectivamente.

`ObservacaoProcessada`, `MovimentacaoRegistrada`, `VinculoEncerrado` e eventos de
revogação/logout disparam o consumidor `reconciliation.v1`. Cada pendência também
grava `ReconciliacaoPrazo` na outbox, com `available_at` no prazo calculado. O prazo
sobrevive a reinícios, inclusive se nenhum antecedente chegar. Necessário executar
`all` ou manter `api` e `events` separados; `api` sozinho não faz reconciliação.

Inbox, decisão, projeção, estado, movimento e nova outbox compartilham a transação
de entrega. O mesmo bloqueio de pedido serializa HTTP e consumidor. Conta e sessão
são conferidas com bloqueio compartilhado na transação, impedindo corrida com
revogação. Falhas sofrem rollback e seguem o retry/lease/CLI da outbox existente.

Pendências são percorridas por recebimento do servidor e UUID para desempate.
O consumidor repete a passagem enquanto algum efeito desbloqueia outra etapa.
Se as condições ainda forem as mesmas, não acrescenta uma revisão redundante.
Pedidos concorrentes não dependem do relógio do aparelho. Não há reordenação de
movimentos já autorizados: expedição/movimentação que perderam a janela após entrega
ficam rejeitadas. Auditoria é eventual; histórico operacional está disponível no commit.

## Contrato público

`POST /api/v1/eventos` e `POST /api/v1/eventos/lote` devolvem o **recibo original**,
também no retry. `GET /api/v1/eventos/{id}` e histórico do pedido devolvem a **decisão
atual** e `historicoDecisoes`, ordenado por revisão. `armazenada: true` não autoriza
movimentação. O contrato de captura continua versão 1, com resposta ampliada:

```json
{
  "armazenada": true,
  "decisao": {
    "revisao": 1,
    "status": "PENDENTE",
    "autorizada": false,
    "motivo": "AGUARDANDO_ANTECEDENTE",
    "avaliadaEm": "2026-10-07T15:00:00.000Z",
    "causaId": null,
    "expiraEm": "2026-10-07T23:00:00.000Z",
    "dependencias": [{ "tipo": "COLETA", "estadoNecessario": "COLETADO" }]
  }
}
```

Exemplo parcial: os campos usuais de captura/decisão e `historicoDecisoes` também
são devolvidos. Após coleta aceita, GET poderá mostrar revisão 2 AUTORIZADA; o
retry POST continua com revisão 1 PENDENTE. `causaId` identifica o evento interno
que causou a reavaliação. Horário da decisão, de recebimento e declarado são distintos.

Estados: AUTORIZADA, PENDENTE, REJEITADA e TARDIA. Motivos terminais adicionais:
`PEDIDO_JA_ENTREGUE`, `VINCULO_ENCERRADO`, `PERMISSAO_REVOGADA`, `SESSAO_EXPIRADA`,
`PENDENCIA_EXPIRADA`, `IDENTIDADE_NAO_VERIFICADA` e `SDM_RESERVA_INVALIDA`.
O mobile guarda o recibo SQLite e atualiza somente a projeção, aceitando revisões
maiores. Envios consulta pendências ao abrir/retomar, reconectar e a cada 15 segundos
em primeiro plano. Histórico também pode ser atualizado pelo botão da tela.

## Reprodução local e evidências

```powershell
npm run db:migrate
npm run lint
npm run typecheck
npm run test:all
npm run build
npm run openapi
$env:MOBILE_REPO = 'C:\src\Nova-tag-expo'
node scripts/reconciliation-acceptance.cjs
```

O teste integrado usa somente PostgreSQL local em banco `_test`, cria usuários e
mensagens sintéticos, abre HTTP temporário e SQLite em `.tmp`, sem tocar dados de
laboratório. Requer Node 24 e ambos os checkouts. `RECONCILIATION_TEST_DATABASE_URL`
permite outro banco dedicado. Não inicia Actions, EAS ou altera hardware.

Supertest/PostgreSQL verifica encadeamento, dependências parciais, concorrência,
duplicação/inbox/reinício, rollback, fechamento/reutilização, logout/revogação,
expiração sem antecedente, migração v1, imutabilidade e as duas políticas SDM.
O script exercita fila mobile → HTTP → PostgreSQL → consumidor → consulta → SQLite
para UID, NDEF e SDM, incluindo reabertura real do arquivo e recibo original.
Jest mobile verifica respostas antigas, recibo imutável e apresentação das decisões.
Bundle iOS local não equivale a instalação nem aceite NFC real.

`/metrics` inclui `nfc_decisions{status=...}` e falhas/pendências da outbox. O indicador
de idade considera apenas eventos já liberados, excluindo agendamentos futuros.
Para inspecionar/reprocessar falhas: `npm run events:failed` e
`npm run events:retry -- <event-uuid>`. A confirmação permanece na transação da inbox.
