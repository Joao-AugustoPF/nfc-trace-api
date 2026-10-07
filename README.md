# NFC Trace API

API experimental do TCC para rastreabilidade logística por NFC. A v1 implementa pedidos,
provisionamento por UID, NDEF estático ou SDM, decisões sobre capturas e histórico logístico.
É um monólito NestJS com domínio independente do framework e eventos persistidos em PostgreSQL.

Esta versão exige **sessão autenticada e permissão por perfil**. A autoria verificada é
separada do operador, aparelho e bloqueio físico declarados pelo cliente. O Nova-tag
integra UID/NDEF e fila offline SQLite; a API recebe lotes com resultado por item.
O SDM usa um perfil candidato versionado, chaves cifradas e políticas estrita/tardia.
Reconciliação durável e decisões versionadas estão disponíveis; aceite físico
completo permanece na #12. Veja [políticas e reprodução](docs/reconciliation.md).

Antes de usar as rotas de negócio, criar o primeiro administrador pelo procedimento de
[autenticação e contas do laboratório](docs/authentication.md). Não há senha padrão.

## Iniciar com Docker

Requisitos: Docker Desktop com o mecanismo Linux ativo.

```sh
docker compose up -d --build
```

O Compose inicializa PostgreSQL 18, aplica as migrations em um processo separado e inicia a API
com o consumidor de eventos. As portas ficam vinculadas a `127.0.0.1`.

- API: <http://127.0.0.1:3000/api/v1>
- Swagger: <http://127.0.0.1:3000/docs>
- OpenAPI: <http://127.0.0.1:3000/openapi.json>
- Prontidão: <http://127.0.0.1:3000/health/ready>
- Métricas: <http://127.0.0.1:3000/metrics> (Bearer de administrador)

Para popular pedidos de exemplo:

```sh
docker compose exec api node dist/platform/database/cli.js seed
```

O seed é explícito e repetível. Ele não registra etiquetas nem confirma configurações físicas.
Os dados persistem no volume Docker. `docker compose stop` interrompe os serviços sem removê-los.

## Desenvolver no Windows

Requisitos: Node.js 24.18 ou posterior da linha 24, npm e Docker Desktop.

```powershell
npm ci
Copy-Item .env.example .env
docker compose up -d postgres
npm run db:migrate
npm run db:seed
npm run start:dev
```

Se a API já estiver no Compose, pare esse serviço antes de iniciar outra API na porta 3000:
`docker compose stop api`. O TypeScript é executado com ts-node para preservar os metadados
dos decorators utilizados pelo NestJS e OpenAPI.

## Verificação

```sh
npm run lint
npm run typecheck
npm run test:all
npm run build
npm run openapi
```

`npm test` executa somente os testes unitários. `npm run test:integration` exige PostgreSQL real.
O banco de integração padrão é `nfc_trace_test`, criado pelo Compose. Para outra instalação,
defina `TEST_DATABASE_URL` no ambiente; o nome precisa terminar em `_test`.
Os testes limpam **somente esse banco de teste** a cada cenário.

Jest 30 usa `--experimental-vm-modules` para carregar os pacotes ESM do NestJS 12 a partir
dos testes CommonJS. O aviso experimental do Node é esperado.

Com a API iniciada, definir `DEMO_LOGIN` e `DEMO_PASSWORD` de um administrador no ambiente;
`npm run demo` autentica, percorre o fluxo de entrega e reenvia cada captura.
Essa demonstração cria dados com leituras **simuladas**, identificados como `DEMO-*` e modelo
`SIMULADA`; não representa validação do hardware NFC.

## Organização

| Camada | Responsabilidade |
| --- | --- |
| `bounded-contexts/traceability/domain` | Agregados e regras puras de rastreabilidade |
| `bounded-contexts/traceability/application` | Casos de uso, consultas e portas |
| `bounded-contexts/traceability/infrastructure` | Repositórios TypeORM e mapeadores |
| `bounded-contexts/traceability/presentation/http` | Contratos e controllers |
| `bounded-contexts/identity` | Contas, sessões, permissões e portas de identidade |
| `platform` | Banco, eventos duráveis, auditoria e observabilidade |
| `bootstrap` | Composição e configuração NestJS |
| `shared-kernel` | Erros e primitivas de eventos |

O fluxo de uma captura é `validar → avaliar → salvar captura/decisão/estado/outbox → commit → responder`.
A auditoria é alimentada depois pelo dispatcher. Reenvios recuperam a decisão original.

- [Arquitetura e decisões](docs/architecture.md)
- [Autenticação, permissões e bootstrap](docs/authentication.md)
- [Contrato e integração do Nova-tag](docs/mobile-integration.md)
- [Sincronização offline e contrato de lote](docs/offline-synchronization.md)
- [SDM, épocas, políticas e administração de chaves](docs/sdm-validation.md)
- [Operação e recuperação da outbox](docs/operations.md)
- [Contrato OpenAPI versionado](docs/openapi.json)
- [Entregas concluídas e trabalho restante](docs/project-status.md)

## Limites da v1

Um pedido representa um volume e tem um vínculo vigente, incluindo vínculos pendentes.
Os estados são `CADASTRADO → COLETADO → RECEBIDO → ENTREGUE`; movimentação e expedição
são marcos adicionais. Capturas sem antecedente podem ficar
pendentes e ser reconciliadas; rejeições definitivas e SDM tardio continuam no histórico
sem movimentação automática. Cada decisão e o recibo original são preservados.

A API recebe a referência NDEF já decodificada pelo aplicativo. Os bytes originais podem
ser enviados separadamente em Base64. UID e NDEF estático identificam cadastros, mas não
autenticam criptograficamente a etiqueta, o operador ou a movimentação física.

O Nova-tag Expo (`codex/issue-6-event-reconciliation`) integra login/SecureStore,
cadastro/busca de pedidos, UID/NDEF, provisionamento em duas etapas, encerramento,
reutilização, eventos, histórico, fila durável e acompanhamento de decisões com a API real. Essas alterações
ainda estão em branch separada da main do mobile. As entregas de software #1/#2/#3
foram aprovadas; personalização/proteção e aceite físico estão concentrados na #12.
Testes de sessão não validam hardware NFC.

A branch acrescenta diagnóstico Type 4 (GET_VERSION, CC, GetFileSettings e NDEF original),
timeout e cancelamento de sessões NFC. O relatório não ativa vínculos nem comprova
SDM/proteção; falta bancada com NTAG 424 DNA, disponível apenas a Feiju do usuário.
O roteiro e os limites estão nos guias 06 a 09 do Nova-tag. A fila atual está no
[status do projeto](docs/project-status.md).
