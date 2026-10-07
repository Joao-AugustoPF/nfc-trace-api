# Reprodução e entrega candidata — preparação da #9

As branches candidatas reúnem #1–#7 e preparação de protocolo/análise #8. Não há
merge na main, piloto NTAG, revisão independente ou aceite final. API e Nova-tag
usam `codex/issue-12-secure-messaging`, sobre API #19 e mobile #7. A #9 continua
aberta até integração autorizada, reprodução pelo colega, #12 e resultados #8.

## Instalação em outra máquina

```powershell
git clone --branch codex/issue-12-secure-messaging https://github.com/Joao-AugustoPF/nfc-trace-api.git
git clone --branch codex/issue-12-secure-messaging https://github.com/brunoaiolfi/Nova-tag.git
cd nfc-trace-api
npm ci
Copy-Item .env.example .env
docker compose up -d --build
```

Pré-requisitos: Git, Node 24.18+ da linha 24 e Docker Desktop Linux. Os diretórios
de checkout podem ter qualquer nome; nos comandos seguintes ajustar os caminhos
quando necessário. Não transportar `.env`, `.tmp`, tokens, credenciais ou bancos
da máquina dos autores para um checkout público. Portas Compose são localhost;
nenhum ngrok, Actions ou EAS é iniciado.

Migrations são executadas pelo serviço `migrate`, antes da API. Seed é explícito:

```powershell
docker compose exec api node dist/platform/database/cli.js seed
```

Cria apenas TCC-001/002/003, repetivelmente, sem etiquetas/contas/leitura física.
Configurar primeiro administrador pelo [bootstrap](authentication.md), com senha
privada somente no ambiente e remoção após uso. Para o Compose, usar `exec -e NOME`
para encaminhar uma variável já definida no processo, sem colocar o valor na linha
de comando. Definir AUTH_BOOTSTRAP_LOGIN/NAME/PASSWORD localmente, executar:

```powershell
docker compose exec -e AUTH_BOOTSTRAP_LOGIN -e AUTH_BOOTSTRAP_NAME -e AUTH_BOOTSTRAP_PASSWORD api node dist/platform/access/bootstrap-cli.js
Remove-Item Env:AUTH_BOOTSTRAP_PASSWORD
```

Administrador cria operadores/consulta pela API. Senhas não vão para EXPO_PUBLIC,
manifestos, relatórios ou argumentos. O laboratório usa PostgreSQL 18; a senha de
exemplo do Compose é de desenvolvimento local, distinta das contas da aplicação.

SDM requer o cofre externo: seguir [geração/rotação/recuperação](sdm-validation.md).
Para injetar o arquivo privado existente no Compose sem copiar seu conteúdo:
`docker compose --env-file .env --env-file .tmp/private/sdm-master.env up -d --build`.
Esse arquivo deve ter acesso restrito e permanecer fora do Git/contexto Docker.
UID/NDEF funcionam sem cofre; SDM indisponível retorna erro explícito, sem fallback.
Esse procedimento ainda não instala chaves no chip; administração física é #12.

## Versão executada e manifesto

`npm run build` escreve `dist/build-info.json` depois do compilador. O sidecar guarda
SHA-256 das fontes/dependências/configuração selecionadas e arquivos compilados.
`GET /health/version` identifica esse build carregado; não lê o checkout a cada
request. Execução ts-node aparece explicitamente sem manifesto de build.
Não exporta caminhos privados, variáveis de ambiente, contas ou chaves.

Docker não recebe `.git`. `BUILD_REVISION` pode declarar SHA completo no build;
origem fica `DECLARADA`, nunca é promovida a revisão conferida por Git. O hash das
fontes realmente copiadas continua disponível. Ausência de SHA aparece como null.
Um build durante mudanças locais mantém o hash efetivo; commit isolado não é prova
de que todos os bytes eram daquele commit. Checksums não são assinatura de autoria.

```powershell
npm run build
New-Item -ItemType Directory -Path .tmp/delivery -Force
npm run release:manifest -- --mobile ../Nova-tag --output .tmp/delivery/candidate.json --protocol experiments/pilot.example.json
# Acrescentar --apk CAMINHO_REAL e --dataset CAMINHO_REAL quando disponíveis.
```

Manifesto tem revisões Git, mudanças rastreadas, hashes por arquivo/lock/build,
configuração pública/versionamento mobile e artefatos presentes. Arquivo deve ser
novo. `apiBuild.sourceMatchesCheckout=false` exige recompilar ou explicar a versão
divergente; não chamar esse artefato de versão atual. Associação APK/dataset→fontes
é declarada pelo executor, requer log de build/instalação e corpus com procedência.
Com `--apk`, Python 3.12+ (somente biblioteca padrão) lê configuração e bundle
embutidos. Conferir `embeddedSourceMatchesCheckout`, versão e revisão efetivas;
esse vínculo de fontes não comprova assinatura, instalação ou funcionamento NFC.
Fonte pública e arquivo privado são coisas distintas: não usar manifesto para
publicar dataset sem verificar dados pessoais/observações/coordenadas.

## Reprodução automatizada isolada

```powershell
npm run lab:reproduce
```

Cria projeto Docker aleatório `nfc-repro-*`, volume/banco novo `_test`, imagens de
produção com `npm ci`/build e porta HTTP aleatória em localhost. Não lê o `.env`
ativo nem usa `nfc-trace`/banco de bancada. Gera credenciais efêmeras em memória;
nunca imprime senhas/tokens. Exercita migrations, seed repetido, bootstrap/login,
UID/NDEF HTTP, ativação repetida, seis tipos de movimento e reenvio do mesmo UUID.
Leituras são fixtures HTTP **sintéticas**, não operações NFC realizadas no app.

Para o backup, interrompe os escritores do projeto próprio e executa pg_dump custom.
Restaura em novo banco, confere quantidade/hash de **todas** as tabelas públicas,
sequência de migrations e trigger de imutabilidade. Inicia a API restaurada e
reenvia as dez capturas, conferindo os recibos originais e ausência de novo efeito;
depois roda o worker real da aplicação no banco restaurado. Mantém relatório, log,
backup privado e volume em `.tmp/nfc-repro-*/`; para os serviços próprios ao final.
Falha preserva recursos para diagnóstico; não recomeçar somente por uma espera
expirada. A execução requer espaço Docker e downloads locais; não consome Actions.

O ensaio não valida NFC, SDM físico, cofre externo, iOS, política de disaster
recovery em produção ou independência de outro integrante. Falhas/leases/inbox,
poison event e retry estão nos testes reais de confiabilidade da API.

### Interoperabilidade administrativa e fila mobile

Depois de instalar as dependências também no checkout Nova-tag (`npm ci`), executar
na API, ajustando o caminho do mobile:

```powershell
npm run test:nfc:mobile -- --mobile-root ..\Nova-tag
```

O [guia do ensaio](nfc-software-rehearsal.md) descreve 11 cenários integrados de
UID/NDEF/SDM, diário SQLite, HTTP, recuperação e ativação. Usa banco/container
próprios e PICC sintética; não depende do servidor de bancada nem de `.env`.
Relatório conserva revisões/hashes, resultados e distinção explícita de zero
leituras físicas/SDK não executado. Não substitui reprodução independente do
colega, instalação no aparelho ou corpus NTAG.

## Backup/restauração de laboratório

Parar **todos** os escritores (API, events, jobs administrativos). Não basta parar
HTTP se worker ainda estiver ativo. Registrar corte, versões e local privado do
cofre SDM; uma restauração antiga também recua reservas de evidência. Não retomar
capturas sem reconciliar o período ausente/épocas e o procedimento #12.

```powershell
docker compose stop api
docker compose ps -q postgres
npm run lab:backup -- backup ID_DO_CONTAINER nfc_trace .tmp/backup-novo
npm run lab:backup -- restore ID_DO_CONTAINER nfc_restore_test .tmp/backup-novo
```

Se há worker separado, pará-lo também. Ferramenta exige PostgreSQL 18, restringe
ACL Windows/mode Linux, guarda custom dump com SHA-256 e contagem/hash das tabelas.
Confere snapshot antes/depois do dump e recusa se houve mudanças. Isso detecta
mudanças observadas, não substitui interromper escritores. Restauração exige
**banco novo `_test`**, checksum válido e transação única; não altera/remove banco
existente. Não oferece troca automática do banco ativo. Conferir triggers,
migrations e operações no clone antes de qualquer decisão de retomada.

Dump contém contas com hashes, históricos e wrappers cifrados SDM. **Não inclui
mestras externas**, não é corpus público nem anonimização. Guardar cofre separado,
com controle de acesso e cópia recuperável; perda da mestra inviabiliza esses
wrappers. Recuperação real com chip/época pertence ao aceite #12. Não usar `down -v`
no projeto de bancada. Recursos `nfc-repro-*` são distintos e descartáveis somente
após conferir projeto/labels e preservar os artefatos necessários.

## Android e rede

O [guia mobile de reprodução](https://github.com/brunoaiolfi/Nova-tag/blob/codex/issue-9-reproducibility/docs/15-reproducao-e-entrega.md)
descreve APK local com bundle embutido, módulos NFC/SQLite/SecureStore e IDs públicos.
Associação NFC deve ser ensaiada em Android real. Emulador verifica instalação/
inicialização, sem provar rádio. iPhone/EAS é complementar e não é iniciado por
esses comandos; Expo Go não contém NFC.

Para telefone na LAN, API precisa escutar interface acessível; host local `npm
start` com HOST=0.0.0.0 e firewall para a rede de laboratório, ou configuração
Compose de exposição deliberada. No telefone, localhost é o próprio aparelho.
Usar IP LAN do computador e `/api/v1`; no emulador Android, 10.0.2.2 representa o
host. HTTPS fora da bancada; conferir URL no login. Publicar novo endereço ngrok
não recompila automaticamente código nativo nem preserva acesso quando o túnel para.

## Demonstração e material do TCC

Roteiro funcional: admin cadastra pedido/vínculo e configura tag; operador registra
COLETA→MOVIMENTACAO→RECEBIMENTO→EXPEDICAO→ENTREGA, com PROVISIONAMENTO gerado na
ativação. Mostrar histórico, uma rejeição armazenada, recibo original versus revisão,
offline com reinício/fila e liberação/reconciliação. Para SDM, demonstrar autenticada,
reutilizada, tardia e autorização separadas **após** #12. Nunca produzir evidência
física a partir do gerador de fixtures.

| Objetivo | Implementação/prova de software | Evidência final restante |
| --- | --- | --- |
| Arquitetura e eventos | domínio/aplicação independentes, 8 limites de imports, PostgreSQL/outbox/inbox | revisão do colega e integração dos PRs |
| Seis eventos/épocas | casos de uso/HTTP/histórico, constraints e testes | ciclo com etiquetas/builds físicos |
| Identidade/permissões | sessões, autoria e SecureStore | reprodução de instalação/contas pelo colega |
| Offline/reconciliação | SQLite, lote, revisões/prazos e testes reais | coleta integrada e falhas com três tratamentos físicos |
| SDM/proteção | verificador/cofre/contadores/políticas, EV2 e personalização recuperável API/mobile | proteção, recuperação, perfil/SDK e corpus NTAG físicos #12 |
| Medidas/experimento | diário, exportação, protocolo/analista preliminares | piloto, amostra final, dados/results/validade #8 |
| Reprodução/entrega | build IDs, migrar v1, backup/restore, comandos e APK candidato | versões integradas, reprodução independente, material final |

Estrutura do material final: problema/escopo; mapa de domínio e ADRs; método/protocolo
efetivamente executado; inventário/build/perfil/épocas; dataset/ground truth/exclusões;
análise reproduzível; resultados e limites; instruções de instalação/diagnóstico.
Não preencher resultados/conclusões com números de fixtures. Conferir a matriz
objetivo→código→experimento→resultado com o orientador e o outro integrante.
