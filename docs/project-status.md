# Entregas publicadas e trabalho restante

Atualização de 7 de outubro de 2026. Branch nos dois repositórios:
`codex/issue-7-experiment-instrumentation`, sobre `codex/issue-6-event-reconciliation`.
Sem merge na main; publicação/backlog autorizados pelo mantenedor. A revisão do
colega, integração das bases e reprodução final permanecem na #9.

## Software entregue

| Issue | Resultado |
| --- | --- |
| #1 | Sessão NFC exclusiva, Type 4, diagnóstico/bytes originais, perfil SDM candidato |
| #2 | Pedidos, vínculos/épocas, ativação/encerramento, seis eventos e histórico |
| #3 | Login/permissões, autoria separada, SecureStore e revogação/logout |
| #4 | Fila SQLite, cache por API/conta/época, recuperação, lote e Envios |
| #5 | Verificação SDM, vetores NXP/NIST, cofre/épocas, reserva concorrente e políticas |
| #6 | Pendências/prazo, decisões append-only/projeção, consumidor/inbox e reavaliações |
| #7 | Roteiros/ground truth, diário de tentativas/falhas, clocks/fronteiras, JSON/CSV/checksum/integridade/métricas e executor de cenários/reexecução |

A #7 salva tentativa antes do SDK e associa ensaio/captura em uma transação SQLite.
Marcadores controlam liberação da comunicação e identificam censura após reinício.
Exportação usa snapshot read-only e não exporta contas/sessões/chaves. Informações
de cliente/observador são declaradas; não equivalem a prova física automática.

## Trabalho restante

A próxima parte independente é **#8: protocolo preliminar e análise reproduzível**.
Pode avançar com controles sintéticos. Piloto/coleta principal requerem #12 e
protocolo/amostra fixados após o piloto, sem inventar resultados.

| Issue | Falta | Dependência para concluir |
| --- | --- | --- |
| [#12](https://github.com/Joao-AugustoPF/nfc-trace-api/issues/12) | Administração/personalização/secure messaging, proteção reversível, recuperação, perfil definitivo e aceite NTAG | Hardware real e implementação/procedimento físico restante |
| [#8](https://github.com/Joao-AugustoPF/nfc-trace-api/issues/8) | Protocolo, piloto, coleta controlada, análise e validade | #12; instrumentação #7 disponível |
| [#9](https://github.com/Joao-AugustoPF/nfc-trace-api/issues/9) | Integração/reprodução das versões finais, APK e material do TCC | #8 e aceites físicos transitivos |

```mermaid
flowchart LR
  I["#7 Instrumentação — software entregue"] --> E["#8 Experimentos"]
  O["#4 Offline — entregue"] --> H["#12 Administração/aceite NTAG"]
  S["#5 SDM — entregue"] --> H
  H --> E
  E --> F["#9 Entrega final"]
```

Somente Feiju está disponível. Fixtures sintéticas/reexecuções não concluem NFC
físico, proteção ou coleta comparativa. [Plano #10](https://github.com/Joao-AugustoPF/nfc-trace-api/issues/10)
conserva as dependências nativas e o trabalho agrupado.

## Verificação da #7

- API: 122 testes/11 suítes, PostgreSQL real e Supertest; lint/fronteiras, tipos,
  build/OpenAPI. Cobertura de papel limitado, idempotência, append-only, rollback
  de medidas/estado/outbox, exportação read-only, integridade e CSV seguro.
- Mobile: 241 testes/24 suítes, SQLite real; lint/tipos e bundle iOS local.
  Migração v1→v2, tentativa antes do SDK, timeout/cancelamento, captura/associação
  atômicas, censura após reinício, resposta perdida e isolamento API/conta.
  Arquivos alterados formatados; formatter global ainda aponta 15 arquivos antigos
  fora do escopo, sem erros de lint.
- Executor: 34 cenários/43 roteiros dos três tratamentos em HTTP/PostgreSQL/SQLite
  reais, validador/CSV/reexecução por OPERADOR. Tempos NFC sintéticos são null;
  dataset identifica censuras, sem erros de integridade nem alegação física.
- Nenhum EAS, Actions ou merge iniciado. Workflows manuais e desativados remotamente.

#4 havia exercitado APK Android/SQLite/SecureStore contra API real, com reinício
no modo offline e resposta perdida. #6 verificou reconciliação dos três tratamentos
com fila mobile e consumidores reais. Nesta #7 não houve instalação iOS ou NFC físico.
Development build iOS precisa de SQLite/rede da #4; #5/#6/#7 são JS/TS. Não
remover o app com fila pendente. `.env`, `.tmp`, dados de bancada, tokens/chaves e
builds não entram no Git.

Guias: [instrumentação](experimentation.md), [reconciliação](reconciliation.md),
[SDM/cofre](sdm-validation.md), [offline](offline-synchronization.md),
[integração mobile](mobile-integration.md). Guias antigos preservam seu histórico,
sem substituir este mapa. Publicações anteriores: API #16 sobre #15, Nova-tag #5
sobre #4; integrar na ordem das bases na #9.

## Publicação da instrumentação

- [API #17](https://github.com/Joao-AugustoPF/nfc-trace-api/pull/17), sobre [#16](https://github.com/Joao-AugustoPF/nfc-trace-api/pull/16), implementação `d459a91`.
- [Nova-tag #6](https://github.com/brunoaiolfi/Nova-tag/pull/6), sobre [#5](https://github.com/brunoaiolfi/Nova-tag/pull/5), implementação `e470e92`.

#7 concluída em software. PRs continuam abertos, sem merge; #9 acompanha revisão,
integração e reprodução final. #8 pode avançar com protocolo e análise de controles;
#12 ainda precisa da administração/aceite físico NTAG 424 DNA.
