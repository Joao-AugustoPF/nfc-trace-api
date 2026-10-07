# Ensaio de interoperabilidade administrativa — somente software

O executor liga o código real do Nova-tag à composição NestJS da API por HTTP
loopback, com PostgreSQL 18 isolado e arquivos SQLite reais. A PICC é sintética:
interpreta APDUs EV2, verifica MAC/contador, cifra/decifra gravações, confere CRC
de troca de chave e conserva arquivos/permissões/chaves entre sessões declaradas.
Os bytes públicos SDM são derivados das chaves instaladas nessa PICC, e não
substituídos por uma resposta HTTP pronta. Há **zero leituras NFC físicas**.

Este ensaio verifica a integração de contratos e recuperação antes da bancada.
Não valida ponte SDK, antena, chip original, duração RF do sistema operacional,
perfil definitivo, bloqueios reais ou incrementos por tap/fragmentação. Não é piloto,
dataset experimental, captura NXP nem aceite físico da issue #12.

## Executar em checkouts locais

São necessários Node 24.18+, Docker com imagem PostgreSQL 18, dependências instaladas
nos dois checkouts e as branches `codex/issue-12-secure-messaging`.
O caminho mobile é explícito; não depende do layout do computador do autor.

```powershell
npm ci
npm run test:nfc:mobile -- --mobile-root C:\src\Nova-tag-expo
```

O executor compila somente as camadas TypeScript utilizadas do mobile em CommonJS,
com verificações estritas, dentro de uma pasta nova `.tmp/nfc-mobile-contract-*`
na API. Carrega aplicação/repositórios reais do servidor com `ts-node` e `rootDir`
explícito para TypeScript 6. Não instala dependências nem modifica o checkout mobile.
O adaptador SQLite Node usa transações `BEGIN IMMEDIATE`; o app continua usando
o adaptador Expo SQLite, verificado separadamente pelos testes móveis/nativos.

Cria projeto Docker próprio, senha/mestra/credenciais aleatórias só em memória,
porta PostgreSQL efêmera em `127.0.0.1` e banco `nfc_mobile_contract_test` com as
sete migrations. A API escuta outra porta efêmera em loopback. Nenhum `.env` do
laboratório é carregado. O alvo privado é preparado pela API a partir de inventário
sintético; não há chave no HTTP ou relatório. As contas são exclusivas do banco
isolado. O reset de dados é restrito a esse banco.

Ao terminar, encerra somente esse servidor/conexões e projeto Docker, removendo
seu volume de testes. Não reinicia nem limpa serviços/dados do laboratório.
Mantém fontes compiladas, diários SQLite sintéticos e `report.json` na pasta de
ensaio, fora do Git. Exceções de SQL/HTTP/criptografia não são impressas; erros
indicam fase/código sem valores privados. Nenhum Actions, EAS, merge ou NFC nativo
é acionado. O comando é explícito, separado da suíte padrão, pois requer outro
checkout e Docker; não é incluído automaticamente no CI hospedado.

## Cenários e provas

| Cenário | O que é conferido |
| --- | --- |
| Ciclo UID | Plano/instalação/conferência, ativação por nova leitura, cinco capturas offline, reabertura/sincronização e seis eventos no histórico |
| Ciclo NDEF estático | Mesmo ciclo com bytes do NDEF efetivamente gravado na PICC; referência do vínculo exato |
| Ciclo SDM | Mesmo ciclo usando chaves instaladas na PICC, evidência de ativação e contadores inéditos das capturas |
| Operação conferida encerrada antes da ativação | Vínculo segue registrado; nova leitura ativa sem retransmitir comandos de configuração |
| Plano não configurado encerrado | Nenhuma APDU; alvo original não reabre, ativação recusada; encerramento explícito do vínculo permite nova época/plano preservando o histórico |
| HTTP perdido após commit da chave 0 | Reenvio do mesmo recibo sem repetir a APDU/troca da chave |
| ACK físico da chave 0 perdido | Tentativa desconhecida, escolha explícita do material, novo identificador RF e mesmo alvo |
| Rede indisponível e SQLite reaberto | Resposta completa guardada, restauração somente HTTP e nova RF para continuar |
| Servidor reiniciado após chave 0 | Canal EV2 descartado; alvo/diário permanecem e recuperação usa novas sessões |
| Novo login durante resposta da chave 0 | Resposta tardia preservada; nova identidade de sessão não envia a resposta antiga |
| ACK da configuração final SDM perdido | Recuperação somente consulta/confere, sem gravação ou segundo reset do contador |
| Resposta da ativação perdida | Consulta do vínculo exato recupera o commit; leitura/reserva não duplicadas |
| MAC de ativação inválido | Rejeição preservada em SQLite, nenhum contador reservado; nova leitura válida ativa o mesmo vínculo |

Toda transmissão sintética exige uma tentativa correspondente já confirmada em
SQLite. UUID de comando não pode ser transmitido novamente. Conferência compara
as cinco chaves/versões instaladas com o alvo original, sem imprimi-las. A
personalização sozinha conserva vínculo REGISTRADA. Capturas offline permanecem
QUEUED antes do envio e sobrevivem à reabertura; os cinco recibos são autorizados,
pedido chega a ENTREGUE e histórico contém os seis tipos, incluindo PROVISIONAMENTO
gerado pelo sistema. Reenvio HTTP conserva histórico/movimentos sem duplicação.

O relatório identifica revisões/hashes API/mobile, hashes do executor/PICC/Compose,
sete migrations e resultado por cenário. Contagens de sessões/comandos são da
simulação; `physicalReads: 0`, `nativeSdkExercised: false` e `nfcTimings: null`
impedem tratá-las como medida física. Criptografia e representação do perfil usam
primitivas/helpers públicos do servidor; vetores oficiais independentes estão na
suíte da API. Isso não torna o simulador um oráculo independente do protocolo do
chip real. Ajustes encontrados na bancada exigem revisão/versionamento explícitos.

Para diagnóstico, use o nome/fase do cenário e estado do diário sintético. Não
publique diários brutos ou credenciais, nem substitua o perfil real por dados deste
ensaio. [Administração e bancada](ntag-administration.md),
[fluxo mobile](https://github.com/brunoaiolfi/Nova-tag/blob/codex/issue-12-secure-messaging/docs/16-administracao-ntag.md)
e [pendências](project-status.md) mantêm as fronteiras de aceites #12/#8/#9.
