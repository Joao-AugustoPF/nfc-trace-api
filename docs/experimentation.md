# Instrumentação do experimento — contrato v1 (#7)

Esta entrega prepara a coleta e seus controles. Fixtures sintéticas e reexecuções
não são novas leituras NFC, aceite de proteção física ou resultados comparativos
do TCC. O protocolo definitivo, piloto, amostra principal e inferência estatística
são #8; a personalização e o aceite NTAG 424 DNA são #12.

## Modelo e autoria

O contexto `experimentation` mantém execução, roteiro de tentativa, avaliações
independentes e estágios do cliente. Domínio/aplicação são TypeScript puro. A
composição conecta PostgreSQL e a autorização por sessão; gravações bloqueiam
conta e sessão na mesma transação para respeitar revogação concorrente.

- `run.id`: UUID da execução; `dataKind` é `FISICO` ou `SINTETICO`.
- `protocolVersion`, `apiVersion`, `mobileVersion`: versões **declaradas** no
  planejamento. Para coleta real, registrar SHAs completos, identificar alterações
  locais e a versão do development build; HEAD sozinho não prova a versão instalada.
- `configuration`: modelo, antena, posição, superfície, capa e timeout em ms.
  Usar códigos visuais, sem nomes pessoais, senhas ou chaves nestes campos.
- `trial.id`, `sessionId`: tentativa planejada e sessão experimental. `sessionId`
  não é a sessão de autenticação. `ordinal` ordena o roteiro dentro da sessão.
- `tagLabel`, `boxLabel`: IDs visuais independentes; `deviceId` é o identificador
  exibido pelo app; `deviceModel`/`osVersion` documentam o aparelho.
- `provisioningId`, `treatment`, `policy`: vínculo/época e tratamento reais da API.
  A política é null fora do SDM. Roteiros divergentes do vínculo são recusados.
- `mode`: `LEITURA_FISICA`, `REEXECUCAO` ou `SINTETICA`. Uma execução sintética
  aceita apenas `SINTETICA`; uma física separa leitura nova de repetição de mensagens.
- `scenario`, `eventType`: cenário e operação planejados. Não inferem verdade física.
- `groundTruth`: avaliação do observador com `legitimate`, `shouldAuthorize`,
  `observedBox`, `observedTag`, `observedOrdinal`, `observedAt` e exclusão/reason.
  `source=OBSERVADOR` exige execução física; fixtures usam `ROTEIRO_SINTETICO`.
  Registrar sem consultar a decisão para definir a expectativa. Correção cria
  outro UUID e nova revisão; anteriores permanecem. O horário é contexto declarado.
- `clientRecords`: UUID por estágio, `trialId`, `attemptId`, `observationId`,
  aparelho, relógio, duração/fronteira/código. `recordedAt`/`userId` são acrescentados
  pela API. Esses tempos e estágios são **declarações do cliente** autenticado.
- `observations`: snapshot normalizado `input`, UID/NDEF/bytes originais, horários
  declarado/recebido, autor autenticado, recibo original, todas as revisões e movimentos.
  Não se exportam tabelas de contas, hashes, sessões, tokens ou chaves SDM cifradas.
- `serverMeasurements`: intervalos produzidos no servidor e vinculados à revisão.

Execução/roteiro/estágios/ground truth/medidas são append-only. Repetir UUID e
conteúdo retorna o registro original; modificar conteúdo retorna 409. Estágios
também exigem o autor original. Tentativas de ensaio que não alcançaram `/eventos`
continuam representadas. UUID de captura no diário não tem FK: pode estar só no app.

## Rotas e permissões

Todas sob `/api/v1`, com Bearer e envelope `sucesso`, `mensagem`, `dados`.
Campos do protocolo experimental/dataset são em inglês e versionados; as rotas
e os estágios são em português. O OpenAPI documenta entradas e envelopes.

| Rota | Perfil | Efeito |
| --- | --- | --- |
| POST /experimentos | ADMINISTRADOR | Criar execução imutável |
| GET /experimentos?pagina=1&limite=20 | Todos | Execuções paginadas (`items`, `total`) |
| POST /experimentos/{id}/tentativas | ADMINISTRADOR | Planejar tentativa, sem executar NFC |
| GET /experimentos/{id}/tentativas?pagina=1&limite=20 | Todos | Roteiros paginados |
| POST /experimentos/tentativas/{id}/observacao-independente | ADMINISTRADOR | Acrescentar avaliação/revisão externa |
| POST /experimentos/registros | ADMINISTRADOR/OPERADOR | Estágio idempotente |
| GET /experimentos/{id}/exportacao | ADMINISTRADOR | Snapshot JSON e métricas |

O operador não cria roteiro, altera ground truth nem exporta datasets. Clientes
adulterados usam esse perfil limitado. A observação independente pode ser
registrada pelo administrador responsável, identificável por UUID autenticado;
o sistema não verifica sozinho a verdade física de uma declaração.

## Fronteiras de medição

Unidade: **milissegundos**. Cada processo/app cria `clockId` próprio. Subtrair
somente amostras do mesmo relógio monotônico. `occurredAt`, `observedAt` e
`recordedAt` não entram nas durações. Reinício troca a origem e censura o intervalo
incompleto (`durationMs=null`, `SEM_RELOGIO_ORIGINAL`); não completar com Date.now.

| Fronteira | Início → fim | Limite da interpretação |
| --- | --- | --- |
| SESSAO_NFC_ATE_EVIDENCIA | imediatamente antes de `readPhysicalTag` → retorno/erro do SDK | Inclui inicialização, descoberta, aproximação, comunicação, decodificação e encerramento nativo; **não é tempo puro de RF**. Persistência do início fica fora deste intervalo. |
| INICIO_ATE_CONFIRMACAO_LOCAL | marcador da tentativa → captura já commitada em SQLite | Inclui aproximação, confirmação humana, resolução/cache e persistência. Marcador da confirmação é salvo antes de mostrar sucesso. Falha entre commit e marcador pode produzir duração ausente, sem perder a captura. |
| ENVIO_ATE_RESPOSTA | início da requisição `/eventos/lote` → resposta validada ou falha | Mesmo aparelho; resposta de lote atribui intervalo comum aos itens. Não mede somente CPU do servidor. Retransmissões têm novos estágios, mantendo o UUID da captura. |
| INICIO_ATE_DECISAO_FINAL | marcador da tentativa → primeira decisão final vista no aparelho | Total operacional; pode incluir espera offline. Separar cenários/modos. |
| LIBERACAO_ATE_DECISAO_FINAL | botão de liberação controlada → decisão final vista no aparelho | Inclui persistência dos marcadores/liberação, rede, fila, reconciliação e consulta. Itens elegíveis recebem o mesmo T0; grupo só termina quando todos têm decisão final na mesma origem. |
| VALIDACAO_EVIDENCIA | antes de avaliar UID/NDEF/SDM → fim da verificação/reserva | Servidor. SDM inclui acesso às chaves e reserva transacional, além de parser/criptografia; não é benchmark isolado de CMAC. |
| PROCESSAMENTO_ANTES_COMMIT | antes de abrir UnitOfWork → imediatamente antes de escrever medidas/commit | Servidor, inclui bloqueios e processamento. Não inclui commit, rede nem retorno HTTP. |
| RECONCILIACAO_ANTES_COMMIT | início da avaliação de uma pendência → nova revisão/outbox prontas | Servidor, por revisão; não inclui commit da inbox nem transporte. |

As medidas do servidor são salvas na mesma transação de decisão, estado e outbox.
Falha na instrumentação desfaz tudo. Reenvio idempotente não cria novas medidas.
Não comparar intervalos de fronteiras diferentes como se fossem a mesma variável.
Separar a latência operacional do SDK da comunicação RF pura no texto do TCC;
para isolar RF seria necessário instrumentar a plataforma/hardware adicionalmente.

## App e operação de coleta

Em **Envios → Ensaio do TCC**, copiar o ID do aparelho, buscar execução física e
selecionar a tentativa. Modelo/caixa/etiqueta/etapa/tratamento vêm do roteiro.
Em **Registrar etapa**, escolher essa etapa e fazer uma leitura física normal.
O início é persistido antes da chamada NFC. Falha, timeout/cancelamento e reinício
também ficam no diário SQLite v2. Os bytes da captura operacional não recebem
metadados experimentais; a associação é um registro lateral na mesma transação.

Cenários offline selecionados pausam novos envios de capturas, consultas de
decisão e estágios deste operador. O botão **Liberar comunicação e sincronizar**
registra T0 e libera o fluxo. Isso é uma barreira do aplicativo, não desligamento
de rede do SO; login/consultas de configuração ainda podem comunicar. Para o
ensaio de intermitência física, bloquear a rede mantendo NFC disponível, registrar
externamente a condição e seguir o protocolo #8. Requisições já em curso não
são revertidas ao escolher um roteiro. Fazer a seleção com a fila ociosa.

Conta/API são preservadas por registro, sem tokens no SQLite. Reenvio de estágios
usa os mesmos UUIDs, backoff e coalescência. Falhas definitivas ficam no aparelho
com contador de recusados; não apagar dados nem inventar etapas para cobrir faltas.
Ground truth é registrado por outra avaliação, fora da decisão automática do app.
O development build precisa de SQLite/rede da #4. A #7 só altera JS/TS e não inicia EAS.

## Exportação e integridade

O endpoint usa transação `REPEATABLE READ`, `READ ONLY`: um snapshot consistente,
sem atualizar observações, decisões, outbox ou dados experimentais. O JSON contém
`schemaVersion=1`, `dataset`, `checksum`, `integrity`, `summary` e `metrics`.
Checksum SHA-256 usa JSON canônico (chaves ordenadas, arrays na ordem exportada).
É verificação de integridade do arquivo, não assinatura nem prova de origem física.

`integrity.status`: `COMPLETO`, `INCOMPLETO` (avisos de faltas/pendências/censuras)
ou `INCONSISTENTE` (identidades/revisões/origens/fronteiras/efeitos divergentes).
O validador aponta tentativa/captura original. Ausência de dados não vira sucesso.
JSON é a fonte autoritativa para bytes e tipos; CSV é visão tabular. Células de
texto com início de fórmula recebem apóstrofo, preservando o valor exato no JSON.

```powershell
npm run experiment:data -- validate .\dados\dataset.json
npm run experiment:data -- csv .\dados\dataset.json .\dados\csv-novo
```

Para buscar a API, definir `EXPERIMENT_API_URL` (terminando em `/api/v1`),
`EXPERIMENT_LOGIN` e `EXPERIMENT_PASSWORD` temporariamente no processo. Usar
credencial ADMINISTRADOR para exportação, HTTPS fora do localhost. Não colocar
senhas em argumentos, fixtures, commits ou histórico do terminal.

```powershell
npm run experiment:data -- export UUID_DA_EXECUCAO .\dados\exportacao-nova
Remove-Item Env:EXPERIMENT_PASSWORD
```

Arquivos: `dataset.json`, `report.json`, `trials.csv`, `ground-truth.csv`,
`client-stages.csv`, `observations.csv`, `decisions.csv`, `movements.csv` e
`server-measurements.csv`. Pasta de saída deve ser nova. Dados de laboratório
e `.tmp` não entram no Git. Usar somente IDs pseudônimos e coordenadas de bancada
quando necessário; o snapshot operacional contém os campos efetivamente enviados.

## Métricas e população

`summary` correlaciona cada roteiro com estágios/capturas/revisões/efeitos e a
última revisão de ground truth, mantendo todas as anteriores no dataset.
`metrics` agrupa por `dataKind`, `mode`, tratamento e política e mantém os IDs
de etiqueta/aparelho/sessão/tentativa para análise por clusters em #8.

- Sucesso de leitura física = `physicalReadSuccess / physicalReadAttempts`,
  somente `LEITURA_FISICA`. Fixtures/reexecuções não entram. `readStageSuccess`
  é a razão dos estágios registrados e pode representar controles sintéticos.
- Preservação = capturas armazenadas / UUIDs de capturas locais. Registrar também
  faltas e filas ainda não enviadas; a razão pode ser provisória.
- FAR operacional = autorizadas em cenários adversos elegíveis / capturas adversas
  armazenadas, com ground truth `legitimate=false`, `shouldAuthorize=false`.
- FRR operacional = rejeitadas ou tardias legítimas que deveriam autorizar /
  capturas legítimas elegíveis armazenadas. `falseRejectsWithoutLate` e
  `lateLegitimate` permitem analisar a recusa temporal separadamente. Falhas de
  NFC não são rejeições do servidor. Pendências continuam explícitas; grupos com
  faltas/pendências são `PROVISORIO`, não conclusão definitiva.
- `authenticated`, `previouslyUsed`, `late`, `pending`, `authorized`, `rejected`
  e `duplicateEffects` são contagens separadas. Rejeição logística/de rede não
  prova detecção criptográfica. Dados excluídos ficam preservados e fora de FAR/FRR.
- Durações individuais mantêm origem/fronteira/unidade. `reconciliationGroups`
  usa T0 comum e máximo dos finais elegíveis; incompleto/reiniciado tem null.
  Sem população elegível, uma razão retorna null, não zero.

Essas são estatísticas descritivas e controles de integridade. A preparação da #8
acrescenta [protocolo e análise offline](../experiments/README.md), mantendo cenários
separados, sessões/etiquetas e intervalos exploratórios condicionais. Não tratar taps
do mesmo telefone/etiqueta como amostras independentes. Piloto/coleta física e
protocolo/amostra definitivos continuam pendentes.

## Cenários reproduzíveis e reexecução

```powershell
npm ci
docker compose up -d postgres
npm run build
# MOBILE_REPO pode apontar para outro checkout da branch #7 do Nova-tag.
npm run experiment:scenarios
```

O executor aceita somente banco local dedicado com nome `_test`, aplica migrations,
usa usuário ADMINISTRADOR para preparação e OPERADOR para capturas adulteradas.
Gera 34 verificações e 43 roteiros para UID/NDEF/SDM: online/offline com reabertura
SQLite, duplicação, concorrência, resposta descartada após commit, reordenação,
cópia NDEF/UID divergente, alteração de bytes/contexto, transferência declarada,
reutilização SDM em novo UUID e primeira apresentação menor ainda não utilizada,
nas duas políticas. UUIDs/chaves de fixture variam; expectativas semânticas são fixas.

Fixtures SDM são do contrato NFC Trace; vetores oficiais NXP/NIST permanecem nos
testes de primitivas. O executor não afirma que a tag produziu essas mensagens.
Leitura sintética tem duração null, por isso o dataset fica `INCOMPLETO` com
censuras conhecidas e sem erros de integridade. Não trocar null por tempo fictício.
Produz JSON/CSVs, expectativas/decisões verificadas e lista de aceitações físicas
pendentes. Também exercita validador, conversor e CLI de reexecução.

O executor de mensagens salvas exige perfil OPERADOR:

```powershell
npm run experiment:replay -- .\dados\fixture.json .\dados\reexecucao-nova
```

Fixture: `{schemaVersion:1,runId,steps:[{trialId,body,expect:{httpStatus:200,
authorized:false,reason:"SDM_EVIDENCIA_REUTILIZADA"},repeat:2}]}`. `body` é o envelope
de `/eventos` com bytes/UUID declarados na fixture. Planejar os roteiros previamente:
execução física exige `mode=REEXECUCAO`; controles sintéticos, `SINTETICA`.
`discardResponse=true` permite controle de perda de resposta após armazenamento.
Não automatiza leitura, troca física, escrita, chave ou bloqueio da etiqueta.
Mensagens reais do aceite #12 poderão ser incorporadas sem alterar esse contrato;
preservar corpus original separado de envelopes adulterados e registrar a procedência.

## Validação desta entrega

API: PostgreSQL real/Supertest, papel limitado, idempotência/conflito, append-only,
rollback conjunto incluindo medidas, exportação sem mutação/credenciais,
ground truth revisável, faltas/inconsistências, checksum e CSV seguro.
Mobile: SQLite real, migração v1→v2, captura/associação atômicas, falhas, censura de
origem após reinício, resposta perdida, isolamento de contas/APIs, liberação
controlada e NFC que só inicia após persistência. Bundle iOS validado localmente.
Nenhuma coleta NTAG física, build EAS ou inferência comparativa foi realizada.
