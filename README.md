# NFC Trace API

API experimental do TCC para rastreabilidade logística por NFC. A v1 implementa pedidos,
provisionamento por UID ou NDEF estático, decisões sobre capturas e histórico logístico.
É um monólito NestJS com domínio independente do framework e eventos persistidos em PostgreSQL.

Esta versão exige **sessão autenticada e permissão por perfil**. A autoria verificada é
separada do operador, aparelho e bloqueio físico declarados pelo cliente. SDM, fila offline
e integração das operações NFC do aplicativo permanecem nas próximas entregas.

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
- [Operação e recuperação da outbox](docs/operations.md)
- [Contrato OpenAPI versionado](docs/openapi.json)

## Limites da v1

Um pedido representa um volume e tem um vínculo vigente, incluindo vínculos pendentes.
Os estados são `CADASTRADO → COLETADO → RECEBIDO → ENTREGUE`; movimentação e expedição
são marcos adicionais. Capturas incompatíveis ficam no histórico com decisão rejeitada.
Não existe reconciliação automática de eventos fora de ordem nesta versão.

A API recebe a referência NDEF já decodificada pelo aplicativo. Os bytes originais podem
ser enviados separadamente em Base64. UID e NDEF estático identificam cadastros, mas não
autenticam criptograficamente a etiqueta, o operador ou a movimentação física.

O Nova-tag recebe login e gestão de sessão no seu próprio repositório. A issue #2 ainda
precisa substituir os serviços operacionais simulados, gerar UUIDs das capturas e integrar
o provisionamento físico em duas etapas. Testes de sessão não validam hardware NFC.
