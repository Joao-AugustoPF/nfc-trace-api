# Autenticação do laboratório — ADR 006

A partir da API 1.1, todas as rotas de negócio exigem sessão. A primeira entrega sem login
continua representada no histórico, mas não há um modo HTTP de desabilitar autenticação.

## Decisão e ciclo da sessão

Usar tokens opacos aleatórios de 256 bits (prefixo `nfc_`) enviados em
`Authorization: Bearer <token>`. O PostgreSQL guarda somente SHA-256 do token.
Cada requisição verifica conta ativa, prazo e revogação no servidor. A duração absoluta
padrão é 8 horas, configurável em `AUTH_SESSION_SECONDS` (60 a 86.400).
Não existe refresh token nem renovação silenciosa: expiração exige senha novamente.

Logout revoga apenas a sessão atual. Um administrador pode revogar todas as sessões de
um usuário ou desativar sua conta. Revogação afeta requisições admitidas depois dela;
uma operação já admitida pode concluir sua transação. Permissões não são inferidas do corpo.

Senhas têm 12 a 128 caracteres, salt individual e scrypt (N=131072, r=8, p=1).
A comparação usa tempo constante. Login desconhecido percorre o mesmo KDF e tem a
mesma resposta de credenciais incorretas. A configuração segue o
[OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
e usa a implementação de [crypto.scrypt do Node](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback).

O limite persistente admite 10 tentativas por login e 60 pelo endereço da conexão em
cada janela de 15 minutos, contando tentativas bem-sucedidas. O limite é compartilhado
entre processos e retorna 429 `LIMITE_LOGIN` com Retry-After. Não confiar em
X-Forwarded-For; atrás de proxy, esse limite considera o proxy até haver configuração
explícita de origem confiável.

## Matriz de permissões

| Operação | ADMINISTRADOR | OPERADOR | CONSULTA |
| --- | --- | --- | --- |
| Consultar pedidos, vínculos e capturas | Sim | Sim | Sim |
| Registrar captura logística | Sim | Sim | Não |
| Criar pedido, registrar/ativar/encerrar vínculo | Sim | Não | Não |
| Criar usuário, revogar sessões, desativar conta | Sim | Não | Não |
| Consultar /metrics | Sim | Não | Não |
| Consultar/encerrar sua sessão | Sim | Sim | Sim |

O laboratório tem histórico operacional compartilhado; não é um sistema multiempresa
com segregação de pedidos por operador. O isolamento abrange sessões, permissões,
atribuição de autoria e reenvio de capturas de outro operador.

Públicos: login, /health/live, /health/ready, /docs e /openapi.json. Não há cadastro
público. Cadastro de perfis e bootstrap são explícitos; nenhuma senha padrão é criada.

## Primeiro administrador

1. Aplicar as migrations (`npm run db:migrate`).
2. Definir localmente `AUTH_BOOTSTRAP_LOGIN`, `AUTH_BOOTSTRAP_NAME` e
   `AUTH_BOOTSTRAP_PASSWORD`, além de `DATABASE_URL`, no .env ignorado pelo Git.
3. Executar `npm run auth:bootstrap`. Somente a identidade pública é impressa.
4. Remover a senha de bootstrap do arquivo/ambiente após usar.

O bootstrap funciona apenas quando não existe conta alguma; o bloqueio transacional
impede dois primeiros administradores concorrentes. Para cadastrar os demais perfis,
autenticar-se como administrador e usar `POST /api/v1/usuarios`.
No Docker, usar o mesmo comando compilado
`node dist/platform/access/bootstrap-cli.js`, fornecendo as variáveis por arquivo de
ambiente local em um container conectado ao PostgreSQL. Não passar senha literal em
argumentos de linha de comando, histórico compartilhado ou exemplos versionados.

## Contrato HTTP

Todos os exemplos abaixo estão sob /api/v1 e usam o envelope sucesso/mensagem/dados.

- `POST /autenticacao/login`: `{ login, senha }` → `{ tokenAcesso, expiraEm, usuario }`.
- `GET /autenticacao/sessao`: → `{ expiraEm, usuario }`.
- `POST /autenticacao/logout`: → `{ encerrada: true }`.
- `POST /usuarios`: `{ login, nome, senha, perfil }` → identidade pública.
- `POST /usuarios/{id}/revogacao`: revoga todas as sessões, mantendo a conta ativa.
- `POST /usuarios/{id}/desativacao`: desativa e revoga as sessões; não permite
  autodesativação. O perfil de uma conta não muda por declaração do cliente.

`usuario` contém id, login, nome e perfil. O token só aparece na resposta do login.
Todas as respostas HTTP têm Cache-Control: no-store. 401 é sessão/credencial inválida;
403 é permissão insuficiente; nenhum desses casos cria captura ou movimentação.
Uma captura válida armazenada com decisão logística negativa continua retornando 200.
Swagger possui autorização Bearer e os schemas dos contratos de autenticação.

## Autoria, auditoria e compatibilidade

`operadorId` e `dispositivoId` continuam sendo declarações imutáveis do payload.
A API acrescenta `autoria` com tipo, usuarioId, sessaoId e perfil verificados na recepção.
O fingerprint do cliente não é alterado com dados da sessão. O mesmo operador pode
reautenticar e retransmitir o mesmo UUID/payload: recebe o recibo original, incluindo
a sessão originalmente gravada. Outro operador recebe 409
`IDEMPOTENCIA_OPERADOR_DIVERGENTE`, sem reatribuição ou efeito duplicado.

A migration adiciona metadados nulos às observações antigas. Elas são apresentadas como
`DECLARADA`; não se inventa identidade autenticada retroativa. Reenvios de uma observação
legada preservam o recibo legado. Seeds internos de laboratório não representam login.

Eventos de negócio incluem `atorAutenticado` no payload da outbox, junto do resultado.
Login, logout, administração e negativas de acesso ficam imediatamente em
`security_audit` (append-only) e na outbox na mesma transação. O consumidor existente
leva esses fatos também a `audit_log`, com deduplicação via inbox. Negativas de acesso
não são decisões logísticas. Senhas, tokens, Authorization e corpos completos não são
gravados nessas trilhas. Rotas auditadas usam o template do endpoint, não sua query string.

## Contrato para o mobile e a próxima fila offline

O Nova-tag guarda token e metadados da sessão em react-native-keychain (Android Keystore),
nunca a senha. Ao restaurar/retornar ao primeiro plano, verifica a sessão no servidor.
Erro de rede preserva o armazenamento para nova tentativa; 401 invalida a sessão local;
403 não encerra a sessão. Não repetir POST automaticamente.

A futura fila (#4) deverá congelar separadamente o payload da captura e o ID do operador
autenticado localmente na captura. Ao enviar, usar
`SessionManager.request(path, { expectedUserId, method, body })`. Se o operador atual
for diferente, interromper o envio e pedir o operador original. Não alterar operadorId,
UUID, época ou evidência para reenviar. Fila e sessão têm ciclos de armazenamento
separados; saída ou expiração nunca devem apagar capturas. Essa identidade local é
contexto declarado, não prova criptográfica de autoria offline.

Logout sem conexão remove o token local e informa que não confirmou revogação remota;
a sessão no servidor expira ou pode ser revogada pelo administrador. Em instalação real
usar HTTPS; HTTP fica restrito ao desenvolvimento Android e ao laboratório local.

## Verificação

`npm run test:all` exercita com PostgreSQL real a matriz de acesso, hash/token,
revogação/expiração, administração, identidade forjada, idempotência entre sessões e
operadores, rate limit, auditoria/outbox atômicas e migration de dados da v1.
Login/Keychain e sincronização física são entregas distintas: NFC real é #1/#2,
SDM é #5, e a fila durável ainda será implementada em #4.
