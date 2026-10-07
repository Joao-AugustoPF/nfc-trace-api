# Contrato para integração do Nova-tag

O contrato executável está em `openapi.json` e em `/docs`. As rotas de negócio exigem Bearer
obtido em `POST /autenticacao/login`; ver [autenticação](authentication.md). A branch
Expo `codex/issue-5-sdm-validation` do Nova-tag já integra login/sessão,
cadastro de pedidos, UID/NDEF estático, provisionamento em duas etapas, encerramento,
reutilização, eventos, histórico e fila SQLite com HTTP real. A main do mobile
ainda representa a versão anterior; consultar a branch ao validar a integração.
As issues #1/#2/#3 registram o software entregue e aprovado; personalização/proteção
e aceite físico completo foram concentrados na
[#12](https://github.com/Joao-AugustoPF/nfc-trace-api/issues/12). A integração dos
PRs na main permanece separada. Veja [situação atual](project-status.md).
O [contrato SDM e gestão de chaves](sdm-validation.md) descreve o provisionamento
administrativo, prova de ativação, perfil, políticas e decisões. O app captura
etiquetas SDM configuradas pela bancada; não executa personalização ou armazena segredos.
O [contrato de lote e as decisões offline](offline-synchronization.md) descrevem
`POST /eventos/lote`, limites, resultado por item, cache e reautenticação.

## Ordem de integração

1. Configurar a URL base e substituir `PedidoEtiquetaService` por chamadas HTTP.
2. Consultar pedidos e guardar o UUID retornado, separadamente do código exibido.
3. Capturar UID, modelo declarado e NDEF disponível.
4. Registrar o vínculo, configurar a etiqueta fisicamente e confirmar a ativação.
5. Gerar um UUID v4 por captura e conservar todo o payload ao repetir a solicitação.
6. Exibir armazenamento e decisão logística como resultados distintos.

Para um aparelho Android conectado por USB, `adb reverse tcp:3000 tcp:3000` permite
usar `http://127.0.0.1:3000/api/v1` no aparelho e manter a API restrita ao computador.
Em desenvolvimento, a configuração Android precisa permitir HTTP local.

## Pedidos e etiquetas

`GET /pedidos?busca=TCC&pagina=1&limite=20` pesquisa código ou descrição, sem
distinção entre maiúsculas/minúsculas, com paginação. `%`, `_` e `\` são caracteres
literais, não curingas. Limite máximo: 100.
`POST /pedidos` recebe `{ "codigo": "TCC-001", "descricao": "Caixa de teste" }`.
Código é único, normalizado para maiúsculas, com letras ASCII, números, ponto, hífen ou underscore.

`GET /pedidos/{id}` acrescenta `provisionamentoVigente`: os detalhes do vínculo
`REGISTRADA` ou `ATIVA`, ou `null` quando não houver. Esse campo permite gerenciar
o vínculo atual pela consulta do pedido. Listas e cadastro continuam devolvendo
o resumo do pedido; consultar detalhes ao abrir o histórico.

O Administrador cadastra pelo app em **Vincular → Escolher pedido → Novo pedido**.
Uma resposta perdida pode ser recuperada buscando o código exato e conferindo a
descrição. Isso é consulta de recuperação, não uma chave de idempotência de criação
nem comprovação de quem cadastrou o pedido. Um `409 CODIGO_PEDIDO_DUPLICADO` continua
sendo conflito; o app mantém os campos para correção ou seleção explícita do existente.

Iniciar um vínculo com `POST /etiquetas`:

```json
{
  "pedidoId": "00000000-0000-4000-8000-000000000001",
  "uid": "04AABBCCDDEE01",
  "modelo": "NTAG424DNA",
  "estrategia": "NDEF_ESTATICO"
}
```

A resposta contém o UUID do provisionamento, `status: REGISTRADA` e `referenciaNdef`.
Para UID, a referência é nula. Para NDEF, grave exatamente a URI retornada em um registro
NDEF URI. O aplicativo deve decodificar a URI completa, incluindo o prefixo NDEF quando usado.

Depois da gravação e configuração física:

```http
POST /provisionamentos/{id}/ativacao
Content-Type: application/json

{
  "bloqueioConfirmado": true,
  "referenciaNdef": "urn:nfc-trace:provisioning:00000000-0000-4000-8000-000000000002"
}
```

Omitir `referenciaNdef` no tratamento UID. A confirmação repetida não duplica o evento
PROVISIONAMENTO. Se o hardware falhar, manter o vínculo pendente e permitir retomada.
Se a resposta de `POST /etiquetas` se perder, consultar `GET /etiquetas/{uid}` e conferir
pedido, estratégia e situação antes de continuar. Não iniciar um vínculo novo às cegas.

`GET /etiquetas/{uid}` retorna o vínculo mais recente, inclusive se estiver encerrado.
`GET /provisionamentos/{id}` consulta uma época específica. O identificador transportado
no NDEF permite consultar o provisionamento mesmo quando o UID da cópia for diferente.

### Encerramento e reutilização

`POST /provisionamentos/{id}/encerramento` exige Administrador e devolve o vínculo
`DESPROVISIONADA`. A repetição desse **mesmo ID** mantém o resultado, sem encerrar uma
nova época da etiqueta. Estado logístico e histórico do pedido anterior são preservados.
O encerramento não remove o conteúdo NDEF físico nem representa uma entrega.

Após perder a resposta, consultar `GET /provisionamentos/{id}` e conferir a situação.
Não recuperar essa operação por `GET /etiquetas/{uid}`, que pode apontar para outra época.
A API permite registrar a etiqueta novamente somente em um pedido `CADASTRADO`, com
novo UUID/época controlados pelo servidor. O modelo declarado da etiqueta permanece
o do cadastro; o mobile preenche esse dado ao reutilizar.

O app exige uma nova leitura do UID escolhido para reutilização. Para NDEF, grava e
relê a **nova** referência antes de ativar. Ao mudar para UID, uma referência NDEF
antiga do projeto precisa ser removida externamente e a etiqueta relida, pois o
resolvedor operacional continua usando essa referência sem fallback. Nenhuma remoção,
proteção por chave ou configuração SDM é executada nesse fluxo.

## Capturas

```json
{
  "id": "00000000-0000-4000-8000-000000000003",
  "versaoContrato": 1,
  "provisionamentoId": "00000000-0000-4000-8000-000000000002",
  "tipo": "COLETA",
  "ocorridoEm": "2026-09-24T12:00:00.000Z",
  "dispositivoId": "android-lab-01",
  "operadorId": "operador-declarado-01",
  "leituraBruta": {
    "uid": "04AABBCCDDEE01",
    "ndef": "urn:nfc-trace:provisioning:00000000-0000-4000-8000-000000000002",
    "modelo": "NTAG424DNA",
    "tecnologias": ["IsoDep", "NfcA"]
  }
}
```

Enviar para `POST /eventos`. `ocorridoEm` exige timezone. Latitude, longitude, operador,
tecnologias, modelo e `bytesBase64` são opcionais; omitir ausentes, sem enviar `null`.
Campos desconhecidos são rejeitados. Corpo máximo: 32 KiB; `bytesBase64` tem limite de 16.384 caracteres.

`leituraBruta.ndef` contém a URI decodificada, não a mensagem NDEF binária. `bytesBase64`
preserva a mensagem original disponível, sem NLEN ou status APDU; omitir quando o
adaptador só disponibilizar registros decodificados. Esses bytes não substituem a URI
usada na decisão da v1 nem são reconstruídos a partir dela.
UID aceita separadores usuais e é normalizado; para a NTAG 424 DNA, use o UID estável de 7 bytes.

O payload não tem campo de estratégia: a API usa o provisionamento registrado. Para NDEF,
UID divergente produz aviso `UID_DIVERGENTE` e classificação SUSPEITO, podendo autorizar
a movimentação se a referência e a sequência forem válidas. Isso preserva a comparação
com o tratamento UID, que rejeita a divergência.

Uma resposta HTTP 200 sempre representa uma captura durável:

```json
{
  "sucesso": true,
  "mensagem": "Solicitação processada.",
  "dados": {
    "armazenada": true,
    "decisao": {
      "autorizada": false,
      "motivo": "AGUARDANDO_ANTECEDENTE",
      "status": "PENDENTE",
      "revisao": 1,
      "dependencias": [{"tipo":"COLETA","estadoNecessario":"COLETADO"}],
      "classificacao": "REGULAR",
      "evidencia": "IDENTIFICADA",
      "alterouEstado": false,
      "estadoAnterior": "CADASTRADO",
      "estadoResultante": "CADASTRADO",
      "avisos": []
    }
  }
}
```

O exemplo omite os campos de captura devolvidos em `dados`. O app deve verificar
`dados.decisao.autorizada` antes de informar que uma operação logística foi aceita.
Uma rejeição definitiva não deve ser reenviada indefinidamente. Pendência logística
é acompanhada por GET/histórico; retry POST preserva o recibo original, mesmo após
reavaliação. Campos de revisão, prazo, dependências e histórico em
[reconciliação](reconciliation.md).
Uma nova leitura/ação terá outro UUID; repetição de transporte mantém o UUID original.

## Erros e consultas

| Situação | Resultado |
| --- | --- |
| Sessão ausente, expirada ou revogada | 401 `SESSAO_INVALIDA` |
| Perfil sem permissão | 403 `ACESSO_NEGADO` |
| Reenvio de captura autenticada por outro operador | 409 `IDEMPOTENCIA_OPERADOR_DIVERGENTE` |
| Mesmo UUID e conteúdo equivalente | HTTP 200 com decisão original |
| Mesmo UUID com conteúdo diferente | 409 `IDEMPOTENCIA_CONFLITO` |
| Pedido ou etiqueta já vinculados | 409 `PEDIDO_COM_ETIQUETA` / `ETIQUETA_VINCULADA` |
| Provisionamento após início da operação | 409 `PEDIDO_JA_INICIADO` |
| Tentativa de ativar vínculo encerrado | 409 `VINCULO_ENCERRADO` |
| Solicitação de estratégia DINAMICA genérica | 422 `ESTRATEGIA_INDISPONIVEL` |
| Cofre SDM não configurado ou indisponível | 503 `SDM_CHAVES_INDISPONIVEIS`; repetir mesmo payload |
| Entrada inválida / JSON malformado | 400 `ENTRADA_INVALIDA` ou código de domínio específico |
| Payload acima do limite | 413 `PAYLOAD_EXCEDIDO` |

Rejeições de domínio de capturas, como `VINCULO_INATIVO`, `VINCULO_NAO_ENCONTRADO`,
`UID_DIVERGENTE`, `NDEF_DIVERGENTE`, `EVENTO_RESERVADO` e `SEQUENCIA_INVALIDA`,
aparecem na decisão de uma resposta 200. Não são erros de transporte.

`GET /eventos/{id}` recupera uma captura, sua decisão atual e todas as revisões. `GET /pedidos/{id}/eventos` retorna histórico
paginado, incluindo rejeições associadas ao pedido e marcos de provisionamento.
Os horários de ocorrência e recebimento são apresentados separadamente. O histórico
é ordenado por recebimento, com UUID como desempate.

Capturas com provisionamento inexistente ficam disponíveis pelo UUID, mas não são
atribuídas a um pedido. O backend não confia em uma associação declarada sem cadastro.

`autoria` separa usuário/sessão/perfil verificados de `operadorId` e `dispositivoId`, que
continuam declarações. Capturas da v1 sem sessão são `DECLARADA`, sem autoria retroativa.
No retry do mesmo operador, a resposta preserva a sessão originalmente gravada.

## Diagnóstico físico separado das capturas

O Nova-tag Expo oferece uma consulta administrativa Type 4 em **Vincular →
Diagnosticar etiqueta**, sem chamadas à API ou alteração de vínculos. Ela consulta
GET_VERSION, capacidade/permissões declaradas no CC e bytes NDEF originais, com
relatório compartilhável. Modelo não confirmado não é substituído por NTAG 424.
Essa consulta não comprova autenticidade, proteção por chave ou aceite SDM;
num chip com SDM a leitura pode avançar o contador.

Na leitura operacional Type 4/IsoDep, o mobile consulta CC/NLEN e preserva a mensagem
NDEF original em `bytesBase64`, sem NLEN, CC ou status APDU. Interpreta a URI dos
mesmos bytes e congela o payload antes da consulta ao vínculo. Não executa GET_VERSION
nessa leitura. No bloco de leitura do arquivo, somente READ_BINARY consecutivos
evitam intercalar outra operação entre NLEN e fragmentos; não é uma alegação de
que o sistema operacional/SDK faça uma única leitura no tap.

Outras tecnologias e a conferência da escrita usam registros do SDK e omitem bytes
indisponíveis. IsoDep sem suporte NDEF declarado pelo SDK mantém o UID disponível,
sem inventar referência ou bytes; isso não autoriza um vínculo NDEF sem referência.
O app não recodifica esses registros como evidência original. Falha
ou truncamento na leitura Type 4 não recupera silenciosamente uma URI do cache/SDK.
O diagnóstico continua separado e seu relatório não é reutilizado numa captura.

A API conserva esses bytes exatamente e eles participam da idempotência: mudar
bytes sob o mesmo UUID retorna `IDEMPOTENCIA_CONFLITO`, mesmo com a mesma URI.
UID/NDEF mantêm o tratamento anterior. SDM exige a mensagem binária do perfil
candidato e sua URI correspondente; o servidor valida PICC/MAC, fixa a época e
reserva contador antes da regra logística. Veja [garantias e limites](sdm-validation.md).

O SDK iOS consultado também chama `readNDEF` ao obter os dados da tag; esse resultado
é descartado na leitura operacional Type 4 em favor da mensagem APDU capturada.
Por isso, ainda precisam ser medidos em bancada os efeitos do SDK/OS sobre o
contador SDM. O diagnóstico v2 acrescenta GetFileSettings somente em chips com
declaração de versão NTAG 424 compatível. O gerador offline de perfil SDM candidato
calcula NDEF/offsets e compara layout/permissões, sem criptografia ou ativação.
Perfil físico definitivo, proteção e aceite da #12 continuam pendentes. Procedimento
e referências em `Nova-tag-expo/docs/08-evidencia-operacional.md` e
`Nova-tag-expo/docs/09-perfil-sdm-bancada.md`. O verificador está implementado em
software; comparação de layout ou GET_VERSION não substituem sua autenticação.
