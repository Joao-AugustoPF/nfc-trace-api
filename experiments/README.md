# Protocolo e análise do experimento — preparação da #8

Esta entrega prepara o piloto e analisa exportações da #7. **Não houve piloto,
coleta NTAG ou comparação empírica física.** O protocolo é preliminar; #8 permanece
aberta até o aceite #12, piloto, congelamento do desenho e coleta principal.
Os arquivos de exemplo contêm rótulos de planejamento, não um inventário confirmado.

## Reprodução local

Node 24 com `npm ci`, Python **3.12**, sem chamadas à API durante a análise.
Criar ambiente separado e instalar dependências fixadas:

```powershell
python -m venv .tmp/experiment-analysis-venv
& .\.tmp\experiment-analysis-venv\Scripts\python.exe -m pip install -r experiments/requirements.lock.txt
$env:EXPERIMENT_PYTHON = "$PWD\.tmp\experiment-analysis-venv\Scripts\python.exe"
npm run test:analysis
npm run experiment:analysis -- plan experiments/pilot.example.json .tmp/pilot-plan
npm run experiment:analysis -- analyze .tmp/corpus/dataset.json .tmp/analysis
```

Pastas de saída precisam ser novas, com pai existente. No Linux, usar `python3.12`,
venv `bin/python` e `EXPERIMENT_PYTHON=/caminho/venv/bin/python`.
O corpus pode vir de `experiment:data export` ou dos controles sintéticos de
`experiment:scenarios`. O último **sempre** gera relatório/gráficos com aviso de
origem sintética e zero leituras físicas. Nenhuma ferramenta inicia NFC ou inventa
respostas do observador. A análise aceita uma exportação por execução; não mescla
rótulos possivelmente homônimos entre datasets. Construir uma execução com as
etiquetas/aparelhos/sessões identificados antes de coletar os blocos comparáveis.

Um comando `analyze` reproduz JSON, sete CSVs, relatório e gráficos PNG/SVG.
O input e o plano são copiados sem alteração; manifesto registra SHA-256 do input,
plano, código do analista/validador e artefatos. A versão API/mobile do cadastro é
**declarada**. #9 ainda precisa do manifesto do build/corpus definitivo. Não tratar
checksum como assinatura nem a declaração `FISICO` como certificação de procedência.

O validador TypeScript verifica o contrato e SHA-256 canônico original. A análise
Python recalcula fatos a partir de linhas brutas; ignora summaries/integridade
alegados no bundle. Inconsistências recusam a execução antes de criar a saída.
Avisos de incompletude são preservados, com pendências e faltas explícitas.
`--no-plots` gera somente tabelas para diagnóstico. `--bootstrap` solicita incerteza
exploratória nos contrastes planejados, sob as restrições abaixo.

## Protocolo preliminar e fronteiras de confiança

Pesquisa aplicada: artefato mobile/API e avaliação controlada de identificação,
autenticação, utilização de evidência e autorização logística. Cenário proposto:
conferência de um volume por pedido, em bancada interna, com interrupções de envio.
API, banco, provisionamento controlado e relógio monotônico do servidor são
confiáveis neste recorte. Cliente autenticado pode mentir sobre UID/contexto.

Ativos: vínculo digital/época, chaves, captura SQLite, mensagens, reservas de contador,
observações/decisões e efeitos logísticos. Fronteiras: tag↔telefone, app↔SQLite,
telefone↔API, API↔PostgreSQL e cadastro↔caixa física. Credencial de operador não
certifica a narrativa enviada. Usar operador com o mesmo papel nos três tratamentos;
admin prepara vínculos, observador externo registra o procedimento.

Incluídos: cópia NDEF, UID/contexto falsos por cliente de laboratório autorizado,
mensagem alterada, evidência guardada/reutilizada/atrasada, disputa concorrente,
falhas delimitadas de rede/ACK/ordem e transferência intacta da etiqueta.
Fora da execução principal: relay de RF, extração física de chave, comprometimento
do servidor/admin/banco, DDoS e perda/destruição completa do armazenamento.
Sem alegação de resistência a esses ataques, proximidade, idade criptográfica,
integridade do conteúdo da caixa ou segurança de produção.

## Três baterias e preparações

| Bateria | Unidade e pergunta | Preparação |
| --- | --- | --- |
| A | Tentativas físicas repetidas, por etiqueta/aparelho/sessão; sucesso e tempo | Mesmo SKU/antena, posição/superfície/capa/timeout controlados; crossover UID/NDEF/SDM |
| B | Objetivos/capacidades adversariais separados | Roteiro externo, caixa/tag identificadas, pré-condições logísticas e evidência anterior documentadas |
| C | Entrega/reconciliação e políticas | Corpus com procedência; reexecuções separadas de leituras; contador/estado inicial e cronograma de entrega registrados |

`scenario-plan.json` fixa expectativas para os 13 cenários do contrato. Cada caso
tem controles positivos/negativos e observador; resultados são por cenário, sem
média global de ataques sem uma distribuição de ameaças justificada. Registrar
objetivo de autenticar evidência e objetivo de autorizar operação separadamente.
Casos inviáveis vão ao relatório com motivo e impacto, nunca como teste aprovado.

### Piloto A proposto

Seis etiquetas físicas do mesmo SKU/lote e antena; três aparelhos **disponíveis**;
uma sessão inicial e dez tentativas por etiqueta–aparelho–tratamento = 540 tarefas,
54 células e seis unidades etiqueta, não 540 observações independentes.
Com dois aparelhos, adaptar o JSON (360 tarefas); não presumir três aparelhos.
Sessões adicionais aumentam o total explicitamente. Quantidade final será outra
decisão, tomada depois do piloto. `timeoutMs=15000` é candidato, não limiar validado.

O gerador distribui todas as seis permutações dos tratamentos entre as etiquetas,
preserva ordem por período e embaralha blocos etiqueta/aparelho e repetições com
seed versionada. Configurações com múltiplos de seis etiquetas mantêm balanceamento.
O calendário não cria UUIDs de provisionamento/captura, ground truth ou resultados.
`observer-template.csv` começa vazio. Registrar ordem **real**, mudanças/desvios e
ligação taskId→trialId; não reescrever o planejado para esconder interrupções.

Antes de cada período: encerrar época anterior, criar **novo pedido CADASTRADO**,
novo vínculo/época e configuração física correspondente. Provisionamento só é
permitido em pedido CADASTRADO. Ativar após verificação; registrar uma COLETA de
preparação para deixar COLETADO. As leituras medidas usam MOVIMENTACAO, repetível
sem mudar estado. Esses eventos de preparação ficam fora das métricas do piloto.
Não repetir COLETA dez vezes e interpretar as rejeições logísticas como falha NFC.
Novas referências/chaves/épocas nunca são transplantadas para outra época.

Baseline UID/NDEF requer configuração física real correspondente, com SDM desativado
quando cabível. Ignorar o MAC mantendo SDM ativo não é o baseline de desempenho.
Proteção reversível, restauração e confirmação da configuração são gate #12.
Se reconfiguração deixar carryover não controlável, redesenhar para grupos do mesmo
SKU/lote, justificar perdas de pareamento e versionar o protocolo antes da coleta.

Uma tentativa começa após persistir TENTATIVA_INICIADA e antes de abrir SDK. Fazer
uma sessão NFC por tarefa; erro/timeout/cancelamento contam e não são substituídos
silenciosamente por nova aproximação. Retentativa planejada ganha task/trial/attempt
próprio. Fechar sessão, afastar tag, registrar leituras de fundo/cache e manter
posição definida. A medida SESSAO_NFC_ATE_EVIDENCIA abrange SDK/descoberta/aproximação/
decode/fechamento; não é tempo de rádio isolado.

### Bateria C e comparação das políticas

ESTRITA e REGISTRO_TARDIO pertencem ao vínculo imutável. **Na implementação atual,
ambas recusam efeito de contador inédito abaixo do maior aceito**, com TARDIA e
motivos diferentes. Não anunciar que a política tardia autoriza entrega antiga.
MAC válido não prova que a mensagem foi recém-capturada.

Preparar épocas independentes e estados iniciais equivalentes; documentar IDs,
fronteira inicial e conjunto já utilizado. Não reapresentar uma mensagem no mesmo
estado consumido e chamar a diferença de efeito da política. O MAC do perfil
inclui referência/época: bytes de uma época não podem ser encaminhados a outra.
Comparar **traces lógicos equivalentes** (mesma sequência relativa de contadores/
tipos/ordem), cada qual com suas próprias evidências autênticas. Literalmente os
mesmos bytes só podem ser reexecutados em ambientes isolados com estado/vínculo
compatível, sem alterar políticas imutáveis ou zerar proteção da bancada ativa.
A equivalência/preparação desse ensaio precisa ser confirmada no piloto, sem
prometer um reset administrativo de contador. Registrar os traces efetivamente
comparáveis; pareamento pelo rótulo não demonstra equivalência dos estados.

No offline usar suspensão controlada dos envios do app: não bloqueia toda rede
do sistema nem cancela requests em voo. Esperar quiescência; congelar lote elegível,
registrar T0 comum, liberar comunicação e aplicar cutoff previamente fixado.
Tempo de reconciliação completo é o máximo dos finais de **todo** o grupo liberado,
incluindo tratamentos diferentes. Reinício/sem final ⇒ censura, não duração zero.

## Ground truth, desvios e exclusões

Observador usa etiquetas/caixas visuais e roteiro externo. Registrar etiqueta/caixa
efetivamente presentes, ordem, horário de referência, origem da evidência, legitimidade,
operação esperada e desvio. Registrar antes de consultar a decisão do verificador
quando possível. Manter revisões/justificativas append-only; a última revisão é
a usada na análise, com as anteriores preservadas. Não derivar legitimidade de HTTP
200, classificação API ou MAC. Identificar pessoas por pseudônimo.

Exclusões do contrato: CONFIGURACAO_DIVERGENTE, PROCEDIMENTO_INTERROMPIDO e
HARDWARE_INCOMPATIVEL, com nota externa detalhada. Somente desvios de procedimento
justificados excluem; falha RF, timeout, rejeição, atraso ou resultado desfavorável
não são, por si, exclusões. Mostrar bruto/excluído/elegível. Nunca excluir depois
de descobrir que um tratamento “ficou pior”. Inviabilidade de hardware é uma
limitação de escopo registrada; Feiju não entra como equivalente à NTAG nos três.

## Denominadores e análise prévia

| Desfecho | Numerador/denominador | Separações obrigatórias |
| --- | --- | --- |
| Sucesso físico | LEITURA_OK / tentativas físicas iniciadas elegíveis | Falhas, interrupções, inconclusas e planejadas não iniciadas |
| FAR operacional | Capturas adversas autorizadas / adversas armazenadas elegíveis | Cenário/capacidade, tratamento/política; não probabilidade universal de falsificação |
| FRR operacional | Legítimas elegíveis REJEITADA ou TARDIA / legítimas armazenadas que deveriam autorizar | TARDIA, REJEITADA, PENDENTE; pendentes no denominador, resultado provisório |
| Preservação no servidor | UUIDs locais também no snapshot servidor / UUIDs CAPTURA_LOCAL | Confirmações locais sem servidor, fila ainda em envio, cutoff |
| Efeito adicional | Movimentações além de uma por UUID | Idempotência por UUID e reutilização SDM em UUID novo são controles distintos |
| Durações | Mediana/IQR/p95 das medidas disponíveis na mesma origem | Fronteira, estágio/falha, revisão, censura e modo |

Captura confirmada localmente e ausente no servidor **não comprova perda local**.
O bundle não exporta o banco SQLite inteiro; para alegar perda, confrontar corpus
do observador/diário com snapshot local recuperado e servidor ao cutoff, registrar
retentativas e causa. Ausências ficam com o nome literal na análise. Autenticada,
previamente utilizada, autorizada, tardia, rejeitada e pendente são contagens distintas.
O código não computa “taxa de detecção correta” sem rótulo de classificação de ataque
externo compatível; erro de transporte não vira detecção de segurança.

Quantis usam interpolação linear tipo 7. p95 com menos de vinte medidas recebe
aviso de instabilidade; vinte não garante precisão. Aparelhos são casos fixos,
etiquetas são unidades repetidas; sessões e ordem permanecem no dataset.
Contrastes explícitos em `analysis-plan.json`: taxas por célula etiqueta/aparelho/
sessão/cenário e medianas de tempo por célula; diferença direita−esquerda, média
dos blocos pareados dentro da etiqueta, depois média com mesmo peso por etiqueta.
Mostrar blocos sem par; diferenças em proporção podem ser lidas em pontos percentuais
ao multiplicar por cem. Não inferir modelo/fabricante com um aparelho de cada modelo.

Por padrão, análise descritiva: nenhuma fórmula binomial/Fisher com taps dependentes
e nenhum p-valor. `--bootstrap` reamostra etiquetas inteiras depois da agregação
pareada, preservando sessões/aparelhos/tratamentos. Percentis 2,5/97,5 de 2.000
reamostragens, seed fixa: **intervalo exploratório**, sem garantia de cobertura ou
generalização a aparelhos. Menos de 12 etiquetas ou ausência de variação entre
etiquetas suprime o intervalo. Doze é uma escolha conservadora preliminar do projeto,
não limite universal de validade; o piloto de seis tags não produz esse intervalo.
Não implementar bootstrap-t/wild bootstrap ou modelo misto fingindo que o desenho
já foi dimensionado. O pós-piloto deve justificar método, população-alvo e precisão.

Bloqueamento/randomização seguem a motivação descrita pelo [NIST](https://www.itl.nist.gov/div898/handbook/pri/section3/pri332.htm).
Dependência e inferência com poucos clusters exigem cautela; [Cameron, Gelbach e
Miller (2007)](https://www.nber.org/papers/t0344) estudam refinamentos bootstrap-t
para esse problema. Essa fonte motiva a cautela, **não valida** automaticamente o
intervalo percentil exploratório desta ferramenta.

## Gate de coleta principal e material pendente

Antes de liberar coleta principal, versionar no Git um relatório de piloto real e
um protocolo final com: evidência do aceite #12, inventário/SKU/configuração, builds
e commits executados, desvios/exclusões/falhas/censuras, distribuições por tag/sessão,
capacidade de reconfiguração, coleta/retentativa/timeout/cutoff, um ou dois desfechos
primários, diferença mínima relevante, cálculo/simulação de precisão/poder com
dependência, quantidade final e regra de parada. Fixar plano antes dos resultados
principais. O gerador preliminar não é comando de aprovação desse gate.

Manter originais read-only e SHA-256; local privado separado do corpus publicável,
registro de acesso e cópia de segurança. Chaves/credenciais não entram no dataset
nem no Git. Esta ferramenta não anonimiza: verificar dados pessoais/coordenadas
antes de publicar. `.tmp` guarda testes/resultados locais e não será versionado.
Após coleta, gerar análise pelo comando, auditar cenários/políticas inviáveis,
descrever validade interna (carryover/cache/operador/ordem), de construto (SDK vs RF,
ground truth/caixa), externa (bancada/aparelhos/SKU) e estatística (poucos clusters,
censura/pendências/contrastes). Só então concluir #8 e material experimental do TCC.
