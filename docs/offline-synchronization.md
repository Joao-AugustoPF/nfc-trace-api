# Sincronização durável — issue #4

O Nova-tag confirma uma captura somente depois do commit em SQLite. A API continua
autenticada: a identidade previamente verificada permite coleta local enquanto sua
validade não expirou, mas não autoriza HTTP nem altera o pedido offline.

## Contrato do lote

`POST /api/v1/eventos/lote` exige Bearer de Administrador ou Operador. Recebe de
1 a 50 itens, com o mesmo contrato de `POST /eventos`. O limite HTTP de 32 KiB
vale para todo o corpo; o mobile monta lotes de até 20 itens e 28.000 bytes UTF-8.

```json
{
  "itens": [
    {
      "id": "00000000-0000-4000-8000-000000000001",
      "versaoContrato": 1,
      "provisionamentoId": "00000000-0000-4000-8000-000000000002",
      "tipo": "COLETA",
      "ocorridoEm": "2026-10-06T12:00:00.000Z",
      "dispositivoId": "instalacao-original",
      "operadorId": "00000000-0000-4000-8000-000000000003",
      "leituraBruta": { "uid": "04AABBCCDDEE01", "bytesBase64": "0QEDVQBh" }
    }
  ]
}
```

O envelope válido retorna HTTP 200, `sucesso: true` e `dados.itens`. Cada resultado
tem `indice`, `id` (ou null), `sucesso`, `status`, `codigo`, `mensagem` e `dados`.
`dados` contém o comprovante original da captura quando armazenada. `status: 200`
e `sucesso: true` por item significam armazenamento; a autorização é
`dados.decisao.autorizada`. Uma rejeição logística também é armazenada.

| Resultado por item | Comportamento do mobile |
| --- | --- |
| 200 / decisão autorizada | Armazenada no servidor; operação aceita |
| 200 / decisão rejeitada | Armazenada; motivo visível; sem retry automático |
| 409 / conteúdo diferente para mesmo UUID | Conflito visível; original preservado |
| Outros 4xx definitivos | Falha visível; registro preservado |
| 401 | Exige o operador original e nova autenticação |
| 408, 429, 5xx, resposta perdida/incompleta | Nova tentativa com UUID e payload originais |

O endpoint valida cada item isoladamente e reutiliza `RecordObservation`, incluindo
suas transações, bloqueios, idempotência, autoria e outbox. Um item inválido ou uma
falha transitória não desfaz itens já confirmados. Não existe transação global do
lote. Autenticação, permissão, envelope, quantidade e limite HTTP são verificados
antes do processamento; falhas nesses pontos rejeitam a solicitação inteira.

Após perda da resposta, reenviar exatamente o payload. UUID/conteúdo normalizado
igual recupera o primeiro resultado; diferente retorna 409. UID/NDEF reaparecendo
em capturas distintas não é idempotência nem proteção contra replay de evidência.

## Decisões do cliente

- SQLite com migration versionada, WAL, transações, payload imutável e primeiro
  comprovante imutável. Logout, expiração, troca de operador e falha não apagam a fila.
- Captura vinculada à API, operador, pedido, provisionamento e época originais.
  Outro operador/servidor não vê nem envia essa captura. Reautenticar o mesmo
  operador permite retomar; o token atual nunca substitui o operador declarado.
- Cache por API/operador somente de vínculos ativos consultados online, por até
  24 horas. Etiqueta desconhecida ou vínculo expirado exigem ação explícita.
  NDEF estático/SDM do projeto resolve sua referência exata sem fallback
  UID. A API revalida vínculo e sequência no recebimento.
- Um envio por item, claim com lease de 45 segundos, FIFO por pedido e backoff
  exponencial limitado a 5 minutos. Resposta atrasada de um claim antigo é ignorada.
  Manualmente, nova autenticação ou reconexão podem antecipar uma tentativa.
- Envio automático em primeiro plano, ao retornar ao app ou recuperar conexão;
  também há botão **Sincronizar agora**. Não há serviço de background nem garantia
  de execução com o app fechado. A próxima abertura recupera os registros.
- Estados de transporte e negócio separados. `AGUARDANDO_ANTECEDENTE` está preparado
  para #6, mas a API atual não reavalia rejeições nem produz essa pendência.
  Consulta posterior atualiza a projeção da decisão sem editar a entrada ou recibo.

Não há associação posterior de etiquetas desconhecidas: a tela informa a limitação
antes de confirmar a captura. Provisionamento/ativação continuam online. Bytes SDM
são opacos ao armazenamento; fixtures de preservação não autenticam SDM.
O [verificador #5](sdm-validation.md) já avalia as mensagens no servidor; 503 do
cofre mantém retry. Reconciliação/versionamento é #6 e aceite NFC físico é #12.

## Verificação local

`test/batch.spec.ts` usa Supertest e PostgreSQL real: UID/NDEF, reenvios concorrentes,
lote misto, falhas por item, autoria, perfis, envelope e limites. Os testes de fila
do mobile usam SQLite real e o código de produção. O guia
`docs/11-captura-offline.md` no Nova-tag descreve o ensaio nativo Android.

`scripts/offline-acceptance-api.cjs` é uma fixture explícita, nunca iniciada pelo
servidor normal. Após `npm run build`, definir `OFFLINE_ACCEPTANCE_FILE` fora do Git
e executá-la. Usa apenas PostgreSQL local em banco terminado em `_test`, cria
contas temporárias aleatórias e vínculos UID/NDEF sintéticos, e atende em 3114.
O arquivo privado contém credenciais efêmeras: não publicá-lo nem servir o Metro
desse harness por ngrok. O ensaio não opera NFC nem toca no banco do laboratório.
