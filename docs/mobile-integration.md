# Contrato para integração do Nova-tag

O contrato executável está em `openapi.json` e em `/docs`. O app atual tem serviços simulados
e captura somente UID. Esta entrega não altera o código do Nova-tag.

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

`GET /pedidos?busca=TCC&pagina=1&limite=20` devolve sugestões. Limite máximo: 100.
`POST /pedidos` recebe `{ "codigo": "TCC-001", "descricao": "Caixa de teste" }`.
Código é único, normalizado para maiúsculas, com letras ASCII, números, ponto, hífen ou underscore.

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
preserva bytes adicionais para inspeção; esses bytes não substituem a URI usada na decisão da v1.
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
      "motivo": "SEQUENCIA_INVALIDA",
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
Uma captura rejeitada não deve ser reenviada indefinidamente: a decisão da v1 é definitiva.
Uma nova leitura/ação terá outro UUID; repetição de transporte mantém o UUID original.

## Erros e consultas

| Situação | Resultado |
| --- | --- |
| Mesmo UUID e conteúdo equivalente | HTTP 200 com decisão original |
| Mesmo UUID com conteúdo diferente | 409 `IDEMPOTENCIA_CONFLITO` |
| Pedido ou etiqueta já vinculados | 409 `PEDIDO_COM_ETIQUETA` / `ETIQUETA_VINCULADA` |
| Provisionamento após início da operação | 409 `PEDIDO_JA_INICIADO` |
| Tentativa de ativar vínculo encerrado | 409 `VINCULO_ENCERRADO` |
| Solicitação de SDM | 422 `ESTRATEGIA_INDISPONIVEL` |
| Entrada inválida / JSON malformado | 400 `ENTRADA_INVALIDA` ou código de domínio específico |
| Payload acima do limite | 413 `PAYLOAD_EXCEDIDO` |

Rejeições de domínio de capturas, como `VINCULO_INATIVO`, `VINCULO_NAO_ENCONTRADO`,
`UID_DIVERGENTE`, `NDEF_DIVERGENTE`, `EVENTO_RESERVADO` e `SEQUENCIA_INVALIDA`,
aparecem na decisão de uma resposta 200. Não são erros de transporte.

`GET /eventos/{id}` recupera uma captura. `GET /pedidos/{id}/eventos` retorna histórico
paginado, incluindo rejeições associadas ao pedido e marcos de provisionamento.
Os horários de ocorrência e recebimento são apresentados separadamente. O histórico
é ordenado por recebimento, com UUID como desempate.

Capturas com provisionamento inexistente ficam disponíveis pelo UUID, mas não são
atribuídas a um pedido. O backend não confia em uma associação declarada sem cadastro.
