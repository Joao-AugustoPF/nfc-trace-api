# Administração NTAG 424 DNA — implementação progressiva da #12

Branch `codex/issue-12-secure-messaging`, sobre a preparação de reprodução #9.
O servidor dispõe do **motor EV2, cofre/inventário de cinco slots, inspeção e
personalização recuperável com diário/API**. Inspeção somente consulta. Personalização
prepara alvo por época, grava/protege e confere UID/conteúdo/configuração/chaves;
nenhuma dessas operações ativa vínculo. Tela/transporte mobile e ativação integrada
após novo RF ainda serão integrados. A #12 permanece aberta; somente Feiju está disponível.

## Inventário privado e fronteiras

O contexto `tag-administration` possui domínio/aplicação TypeScript puros, portas
de transação, relógio, identificadores, cofre e canal; Nest/TypeORM/Node ficam nos
adaptadores. A projeção SQL de rastreabilidade bloqueia pedido antes do vínculo;
a composição Nest injeta o motor EV2 e os adaptadores. A sexta migration acrescenta
seis tabelas: credenciais/inventário, inspeções/sessões, diário e recibos.

Importar as cinco credenciais **conhecidas** da tag e suas versões, em ordem 0–4:

```powershell
npm run nfc:inventory -- import --input .tmp/private/tag-credentials.json
```

O arquivo JSON contém exclusivamente `uid` (14 caracteres hexadecimais maiúsculos)
e `slots`: cinco objetos `numero`, `versao` (0–255) e `chaveHex` (32 caracteres
hexadecimais). Não inserir chaves na linha de comando, Git, app, logs ou relatórios.
Não há geração/uso implícito de credenciais de fábrica nem tentativa de alternativas.
Arquivos precisam ficar diretamente em `.tmp/private`, sem symlink; tamanho máximo
8 KiB. Windows aplica DACL apenas do usuário atual, removendo também entradas
explícitas de terceiros; outros sistemas exigem permissões sem acesso de grupo/outros.
A CLI retorna somente referência e classificação **declarada, não autenticada**.

AES-256-GCM cifra os 80 bytes, vinculando propósito/referência/UID/versões e versão
da mestra por AAD. A mestra externa usa a configuração privada existente
`SDM_ENV_FILE`/keyring, com propósito diferente do cofre SDM. Guardar o keyring
separadamente do backup PostgreSQL; conservar todas as versões ainda usadas pelos
wrappers. A CLI `sdm:keys rewrap` trata apenas o material SDM e **não** estes novos
wrappers. `nfc:inventory rewrap` trata o cofre administrativo, inclusive os alvos de
personalização. Credenciais/referências anteriores
são preservadas. Importação substitui a referência vigente apenas após encerrar
a inspeção aberta e produz outbox auditada `InventarioNfcDeclarado`.

## Contrato administrativo disponível

Todas as rotas abaixo exigem ADMINISTRADOR e seguem o envelope `sucesso`, `mensagem`,
`dados`. Conta/sessão são revalidadas na transação, com bloqueios que impedem revogação
concorrente durante o efeito no banco. Estação e UUID RF são declarações do cliente,
não identidade certificada do aparelho. Usar TLS ao acessar pela rede.

| Método/rota sob `/api/v1/administracao-nfc/inspecoes` | Entrada/resultado |
| --- | --- |
| `POST /` | `{id, provisionamentoId, estacao}` prepara plano imutável de vínculo REGISTRADA, modelo declarado NTAG424DNA, UID/época/estratégia/ref/versões e hash |
| `GET /{id}` | Estado atual; detecta sessão expirada/perdida e registra interrupção |
| `GET /{id}/diario?pagina=1&limite=25` | Diário append-only paginado, na ordem de recebimento do servidor |
| `POST /{id}/sessoes` | `{id, sessaoRfId, estacao, recuperar}` abre canal isolado; UUID RF novo após interrupção |
| `POST /{id}/sessoes/{sessaoId}/respostas` | `{comandoId, sessaoRfId, estacao, respostaHex}` registra a resposta completa com SW1/SW2 no final e devolve checkpoint |
| `POST /{id}/sessoes/{sessaoId}/interrupcao` | `{sessaoRfId, estacao}` cancela RF e conserva plano para recuperação; conta criadora pode cancelar após novo login |
| `POST /{id}/encerramento` | `{estacao}` cancela/encerra de forma idempotente, liberando nova inspeção/importação |

Plano: PREPARADA → INSPECIONANDO → INSPECIONADA; falha leva a INTERROMPIDA;
encerramento explícito leva a ENCERRADA. Existe no máximo uma operação aberta por
UID; mesmo identificador com outra conta/vínculo/estação retorna 409. Somente a conta
e estação criadoras continuam/encerram. A sessão também fica vinculada à sessão
autenticada e ao UUID RF, com prazo fixo de três minutos, sem renovar por repetição.

O servidor escolhe 21 quadros: First do slot 0, UID autenticado, configuração do
arquivo NDEF de 256 bytes, versões 0–4, NonFirst/UID de cada slot 1–4. Todas as cinco
chaves são efetivamente autenticadas, não apenas suas versões consultadas. Divergência
de UID/versão/configuração, MAC inválido ou autenticação recusada encerra o canal.
Não há endpoint para instruções/APDUs arbitrárias. A identificação de modelo/CC
prévia no aparelho será integrada antes desta sequência; UID/chaves conhecidos não
certificam originalidade do chip.

Cada comando recebe identidade/sequência e intenção gravada **antes** da emissão.
Resposta, recibo, intenção seguinte e outbox têm commit conjunto. O diário conserva
etapa/hashes/resultados, sem chaves nem respostas brutas. O checkpoint privado
guarda a APDU do comando pendente; isso não é material de chave em texto claro.
Auditoria usa o consumidor/inbox existente após o commit; diário está disponível
imediatamente. Nenhuma transação PostgreSQL abrange o efeito físico NFC.

Reenvio HTTP da mesma resposta normalizada (hex sem distinção de caixa) não avança
duas vezes. Conteúdo diferente para o mesmo comando retorna 409. A repetição devolve
o **checkpoint atual**, evitando APDU antiga após outras respostas; recibo original
é imutável no banco. O cliente deve transmitir cada `comando.id` no máximo uma vez
por sessão RF. Repetir HTTP não autoriza retransmissão NFC. Falha de protocolo
armazenada retorna HTTP 200 com `dados.status=INTERROMPIDA`, `codigo` e comando null;
`sucesso` significa solicitação processada, não personalização concluída.

Segredos EV2 vivem apenas no processo e são limpos por melhor esforço ao concluir,
cancelar ou expirar; varredura de memória a cada cinco segundos. Após reinício/rollback
que avance o canal, ele é descartado: o próximo acesso marca sessão perdida e exige
`recuperar:true` com novos IDs de sessão/RF. Não se recuperam chaves de sessão antigas
a partir do banco. Ao recuperar inspeção, nada persistente foi alterado fisicamente;
personalização usa a mesma infraestrutura, com material e resultado físico explícitos
conforme a seção abaixo.
Remoção/cancelamento no aparelho deve chamar a interrupção da sessão antes de recuperar;
não é preciso aguardar o lease. Encerramento da inspeção é uma ação final distinta.

Mesmo finalizada, a inspeção mantém o vínculo REGISTRADA. Resultado explicita
`personalizada:false`. A Feiju não usa este fluxo; não configurar seu modelo como
NTAG424DNA para contornar compatibilidade.

## Protocolo implementado

### Personalização e recuperação de mutações

`POST /api/v1/administracao-nfc/personalizacoes` recebe `{id, provisionamentoId,
estacao}`. Exige ADMINISTRADOR, vínculo REGISTRADA, modelo compatível e inventário
importado. A transação gera/cifra o alvo uma única vez por época; reenvio conserva
plano. Não gerar outro alvo para recuperar. Operação sem mutação pode ser encerrada
e o vínculo desprovisionado para criar nova época; após mutação, conferir primeiro.

`GET /api/v1/administracao-nfc/provisionamentos/{id}/personalizacao` localiza a operação
original pelo vínculo, inclusive depois de perder os IDs locais. Continua exigindo
ADMINISTRADOR; a execução permanece vinculada à conta/estação originais.

Rotas comuns sob `/api/v1/administracao-nfc/operacoes/{id}`: consulta, `diario`,
`sessoes`, `sessoes/{sessaoId}/respostas`, `sessoes/{sessaoId}/interrupcao` e
`encerramento`. `/inspecoes/{id}` conserva aliases. O plano `personalizacao` contém
referências/versões alvo, imagens CC/NDEF e configurações públicas; nenhuma chave.

Estados PERSONALIZANDO → PERSONALIZADA. Cada comando informa `alteraTag`; a sessão
informa `alteracaoFisica`: NAO_ALTERADA, NAO_CONFIRMADA ou CONFERIDA. Intenção de
mutação já implica efeito não confirmado: transmissão/aplicação podem ocorrer com
perda de resposta. Somente a conferência completa retorna `personalizada:true` e
promove o alvo ao inventário. Cancelamento/lease/reinício conservam a pendência.
Ativação e encerramento do vínculo são impedidos durante alteração desconhecida.

1. Autenticar os cinco slots selecionados, UID e versões antes de qualquer alteração;
   confirmar CC 32/NDEF 256 e Change=0. Não executar SetConfiguration, bloqueios
   irreversíveis, RandomID, LRP ou limite de falhas de autenticação.
2. Aplicar acesso temporário FULL Read/Write/Change=0. Conferir CC original; gravar
   CC com NDEF WriteAccess=FF, mantendo acesso administrativo. NLEN zero, corpo em
   trechos de até 80 bytes, conferência do corpo, NLEN final e conferência dos 256
   bytes por FULL. Isso evita depender de native frame chaining.
3. Persistir DADOS_CONFERIDOS antes do perfil final. Nova escrita invalida o checkpoint,
   conservando recibos antigos. Trocar slots 1–4 quando necessário, slot 0 por último;
   ACK sozinho é insuficiente. AuthenticateEV2First com alvo, UID, versões e prova
   de todas as chaves. Aplicar/conferir CC e NDEF finais. UID deixa NLEN zero; estático
   usa URN do vínculo; SDM conserva perfil candidato/offsets e chaves 1/2 da época.
4. Conferir configurações por MAC e CC por FULL. O NDEF final permite leitura pública;
   essa leitura não é prova FULL. A prova dos bytes precede o perfil público e está
   ligada ao plano/recibo. Nenhuma operação administrativa ativa o vínculo.

Recuperação exige `recuperar:true`, novos UUIDs de sessão/RF e `materiais`: cinco
valores ATUAL/ALVO em ordem 0–4. Selecionam referências seladas, não recebem chaves.
Não há tentativa automática de credencial alternativa. Uma escolha incompatível
interrompe; versão sozinha não autentica chave. Exemplo após slot 1 instalado:

```json
{"id":"<novo-uuid>","sessaoRfId":"<novo-uuid-rf>","estacao":"bancada-1","recuperar":true,"materiais":["ATUAL","ALVO","ATUAL","ATUAL","ATUAL"]}
```

Reabilitar SDM reinicia o contador. Perfil final já aplicado, cinco slots ALVO e prova
persistida permitem somente autenticação/conferência, sem escrita/troca/configuração.
Sem prova ou material parcial incompatível, parar. Nenhuma mutação é emitida depois
de evidência reservada para a época. Após uso, reconfiguração exige nova época/material.
O comportamento de acesso livre e reset está descrito no [datasheet NXP, seções
8.2.3.3 e 9.3.1](https://www.nxp.com/docs/en/data-sheet/NT4H2421Gx.pdf).

### Rotação do cofre administrativo

Adicionar a nova mestra ao keyring externo, manter as anteriores e escolher a nova
como ativa; executar `npm run nfc:inventory -- rewrap`. Todas as referências atuais,
alvo e históricas recebem wrappers append-only e outbox na mesma transação. Falha
aborta o conjunto. IDs, UID, versões, planos, contador e chaves físicas não mudam;
leitura usa o wrapper mais recente. CLI só imprime contagem e confirmação de que
chaves físicas não foram alteradas.

Cofre SDM é separado: executar também `npm run sdm:keys -- rewrap`. Os dois comandos
não formam transação conjunta. Conservar versões mestras antigas até verificar
ambas as rotações e recuperação de backups que ainda dependem delas. Keyring externo
não está no dump PostgreSQL. Não exportar material alvo por HTTP/mobile.

### Motor de protocolo

`src/platform/nfc/ev2.ts` implementa uma sessão RF: AuthenticateEV2First/NonFirst,
derivação de chaves, contador/TI, envelopes MAC/FULL, GetCardUID, GetFileSettings,
GetKeyVersion, ReadData/WriteData, ChangeFileSettings e ChangeKey. O adaptador
`NodeEv2Cryptography` usa Node crypto no servidor, sem módulo/chave novo no mobile.
AES-CMAC agora está em `platform/cryptography`, compartilhado com o verificador SDM;
o contrato SDM mantém seus vetores e comportamento anteriores.

Referências primárias: [datasheet NXP Rev. 3.0, §§9.1/10](https://www.nxp.com/docs/en/data-sheet/NT4H2421Gx.pdf)
e [AN12196 Rev. 2.0, tabelas 14/18/23/25/26](https://www.nxp.com/docs/en/application-note/AN12196.pdf).
Os testes usam constantes públicas dessas tabelas para autenticação, derivação,
IV, ChangeFileSettings e os dois casos de ChangeKey, comparando bytes completos.
Os demais casos são respostas sintéticas identificadas, não mensagens físicas.

- Autenticação usa AES128-CBC com IV zero e sem padding. A confirmação valida
  desafio rotacionado e eco de capacidades; não aceita LRP/fallback implícito.
- Comandos usam contador atual; respostas usam contador incrementado. MAC é
  conferido antes de liberar dados decifrados. Padding Method 2 sempre acrescenta
  80h/zeros, inclusive bloco adicional para dados múltiplos de 16.
- CRC de ChangeKey usa o estado acumulado, sem complemento final, e saída little
  endian: a chave pública da tabela 25 produz `789DFADC`, não o CRC pós-complemento
  usual de outras bibliotecas. XOR da chave antiga só é usado nos slots 1–4.
- SW1/SW2 são os dois últimos bytes da APDU recebida. Na tabela 18 da application
  note a linha da resposta inverte a apresentação do status/MAC; o teste usa o
  formato wrapped APDU do datasheet. Não copiar essa ordem textual para o SDK.
- NonFirst conserva TI/contador e troca as chaves de sessão. Não renova o limite
  de comandos. Por padrão são 128 comandos por sessão; nunca há wrap do contador.

## Invariantes do motor

Autenticar com slot 0 não autoriza escrita por si só. `confirmUid(expectedUid)`
precisa comparar o UID obtido em resposta FULL autenticada antes de qualquer
mutação. `uid()` somente consulta e não habilita escrita. Outros slots autenticados
podem consultar; mutações exigem slot 0. Não há tentativa automática de chave zero,
reenvio de APDU ou mudança de tratamento após falha.

Há um comando pendente por vez. MAC/status/comprimento/padding inválidos encerram
o canal, sem prosseguir. `interrupt()` encerra e indica se uma mutação emitida pode
ter efeito físico desconhecido. Erros após resposta incompleta/corrompida de uma
mutação retornam `physicalOutcome: NAO_CONFIRMADO`; não presumir que nada foi gravado.

WriteData usa quadros pequenos, no máximo 128 bytes por trecho, respeitando arquivos
CC/NDEF/proprietário. A sequência de gravação de NLEN pertence ao plano pendente.
ChangeFileSettings preserva alteração/escrita por slot 0,
recusa ReadWrite livre, permissão administrativa F e bits/modos reservados. O motor
não expõe SetConfiguration para conversão irreversível para LRP, RandomID ou limites
de falha de autenticação. Formato/offsets/permissões finais ainda serão determinados
pelo plano autoritativo, não por parâmetros arbitrários de HTTP.

ChangeKey do slot 0 encerra autenticação e recebe ACK sem MAC. O recibo marca
`responseAuthenticated:false` e `reauthenticationRequired:true`; isso **não prova**
que a nova chave foi instalada. Outra sessão deve autenticar com o material novo,
confirmar UID/versões/configuração e recuperar ambiguidades antes de concluir.

Chaves/desafios/sessão ficam em campos privados e não aparecem em JSON/inspeção
ordinária. Buffers pertencentes ao canal são zerados ao encerrar; buffers do chamador
não são modificados. Isso é limpeza em memória por melhor esforço, não memória
protegida nem garantia de apagamento de todas as cópias internas do runtime/OpenSSL.
O chamador deve fechar o canal em cancelamento/expiração/falha de transporte.

## Próxima integração da mesma #12

A decisão arquitetural é manter criptografia e material privado no servidor.
O mobile será transporte APDU em uma sessão administrativa separada, usando sua
ponte NFC real. Próximas partes **ainda devem ser implementadas**, na ordem:

1. Tela de bancada isolada no Nova-tag: identificação compatível antes de comando
   específico, sessão NFC exclusiva, progresso persistente, confirmação de plano,
   cancelamento e recuperação. A Feiju continua incompatível com este protocolo.
2. Transporte durável por comando: antes de transmitir, registrar localmente que
   houve tentativa. Reenviar somente a resposta HTTP preservada; nunca retransmitir
   APDU por timeout de rede. Recuperação com seleção dos slots e novo RF.
3. Nova sessão RF para leitura dinâmica e ativação existente, sem reset automático
   ou ativação apenas pelo ACK. Reconfiguração de época ATIVA exige encerramento/nova
   época; recuperação parcial de uma operação pendente deve conservar seu alvo.

TLS e conta administrativa continuam necessários no transporte HTTP. Um MAC válido
na configuração autentica a conversa com a chave correspondente; não certifica
originalidade do chip, verdade logística ou proteção física sem teste negativo.
Chave de transporte conhecida/publicamente disponível não prova originalidade.

## Evidência desta etapa

Motor: 20 testes EV2 com vetores NXP e casos adversariais/sintéticos. Inventário/API:
3 testes de cofre/parser e 17 testes de integração com PostgreSQL real/Supertest/PICC sintética,
incluindo importação CLI real/ACL Windows, cinco slots, UID/chave/versão errados,
concorrência/idempotência, lease/reinício, autorização/revogação, vínculo encerrado,
append-only, rollback da intenção **e** da resposta/canal e separação dos schemas
OpenAPI de login/inspeção. Mais 20 testes de personalização: três tratamentos,
gravação/troca de chaves, ACK perdido, SDM sem reset, provas ausentes, concorrência,
reenvio, reinício, cofre e rollback transacional. A suíte completa e
verificações finais estão registradas no [mapa de entregas](project-status.md).

Houve personalização apenas contra PICC sintética. Não houve leitura NFC física,
tela mobile nova, firmware, EAS,
GitHub Actions ou merge. Builds móveis e seus aceites anteriores permanecem na #9.
O material final e o piloto continuam dependentes de implementação/aceite #12 e #8.
