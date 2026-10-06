# Operação do laboratório

## Configuração

| Variável | Padrão | Uso |
| --- | --- | --- |
| DATABASE_URL | Obrigatória | PostgreSQL da aplicação |
| TEST_DATABASE_URL | Banco local `nfc_trace_test` | Somente testes; fornecer no ambiente |
| APP_PROCESS_ROLE | all | all, api ou events |
| HOST | 127.0.0.1 | Interface HTTP; dentro do container é 0.0.0.0 |
| PORT | 3000 | Porta HTTP |
| OUTBOX_POLL_MS | 1000 | Intervalo entre ciclos |
| OUTBOX_LEASE_MS | 30000 | Prazo de reivindicação de eventos |
| OUTBOX_BATCH_SIZE | 25 | Eventos reivindicados por ciclo, máximo 100 |
| AUTH_SESSION_SECONDS | 28800 | Validade absoluta da sessão, de 60 a 86400 segundos |

`all` executa HTTP e dispatcher; `api` executa apenas HTTP; `events` executa o consumidor
sem abrir uma porta HTTP. Todos usam o mesmo banco e imagem. Migrations são comandos
explícitos; o worker nunca modifica o schema na inicialização.

## Banco e mudanças de schema

```sh
npm run db:migrate
npm run db:seed
```

Nunca habilitar `synchronize` no TypeORM. Criar migrations para mudanças e registrá-las
em `createDataSource`. Triggers impedem atualização/exclusão de observações, decisões,
movimentações e auditoria. O histórico deve ser corrigido por novos registros definidos
em uma evolução do contrato, não por sobrescrita informal.

O volume Docker preserva os dados. A restauração de backups também restaura o estado de
idempotência e de entrega; não misturar cópias de tabelas de épocas diferentes.

## Outbox e reprocessamento

```sh
npm run events:failed
npm run events:retry -- <uuid-do-evento-interno>
```

No container:

```sh
docker compose exec api node dist/platform/messaging/cli.js list
docker compose exec api node dist/platform/messaging/cli.js retry <uuid-do-evento-interno>
```

O UUID interno da outbox é diferente do UUID da captura. `causationId` liga os eventos
decorrentes de uma captura ao seu UUID. `correlationId` liga o processamento à requisição;
o cliente pode enviar `x-correlation-id`, limitado a 100 caracteres seguros.

As tentativas automáticas são limitadas a cinco, com esperas de 1, 2, 4 e 8 segundos
entre falhas. Eventos com lease expirado são recuperados; expiração após a quinta tentativa
resulta em FAILED. Reprocessar exige corrigir a causa e recolocar o mesmo evento na fila.
O comando reinicia as tentativas, preservando a identidade e a inbox.

Consumidores não confirmam eventos antes do commit. O consumidor de auditoria e a inbox
estão na mesma transação. Um worker antigo não consegue confirmar a reivindicação de outro
worker porque a posse é verificada pelo token.

## Observabilidade

- `/health/live`: processo HTTP disponível.
- `/health/ready`: PostgreSQL responde e a tabela de outbox existe.
- `/metrics` (Bearer de administrador): contagem de eventos PENDING, PROCESSING, FAILED e PROCESSED, além da idade
  do evento pendente mais antigo.
- Logs JSON: correlação, rota, método, resultado HTTP e duração monotônica.

Uma resposta de captura só é devolvida depois do commit. Se o worker parar, os registros
logísticos continuam consultáveis e a outbox acumula eventos. Ao reiniciar, a auditoria retoma.
Logs HTTP não incluem leituras, segredos ou corpos completos.

Login, logout, administração e negativas de acesso ficam em `security_audit` e na outbox
atomicamente. São distinguíveis das decisões logísticas em `observations`/`decisions`.
O procedimento de criação explícita de contas, revogação e sessão mobile está em
[autenticação](authentication.md). O bootstrap exige variáveis locais e não cria contas padrão.

O desligamento gracioso interrompe novos ciclos, aguarda o ciclo em andamento e fecha o banco.
Falhas abruptas são cobertas pela persistência e expiração de lease.

## Verificações locais e GitHub Actions

Para economizar minutos do GitHub Actions, o workflow possui somente o gatilho manual
`workflow_dispatch`. Pushes, PRs e merges não iniciam jobs automaticamente. O workflow
também foi desabilitado no GitHub durante a transição: somente reabilitar após integrar
esta configuração na branch principal, para não restaurar os gatilhos antigos da main.
Execuções manuais ficam reservadas a uma necessidade explícita de validação remota.

Antes de publicar alterações, executar localmente, com PostgreSQL de testes disponível:

```sh
npm run lint
npm run typecheck
npm run format:check
npm run test:all
npm run build
npm run openapi
git diff --exit-code -- docs/openapi.json
```

O último comando pressupõe que o contrato gerado já foi incluído no commit.

## Validação física futura

Os testes automáticos usam leituras sintéticas. A aceitação com hardware exige conferir
leitura NDEF, configuração das permissões e bloqueio efetivo em NTAG 424 DNA. Essa validação
será feita com a integração do Nova-tag; a API não observa o rádio nem comprova o bloqueio.
