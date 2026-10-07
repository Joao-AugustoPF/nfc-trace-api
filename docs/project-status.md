# Entregas publicadas e trabalho restante

Atualização de 7 de outubro de 2026. API:
`codex/issue-8-experimental-protocol`, sobre `codex/issue-7-experiment-instrumentation`.
Mobile permanece em `codex/issue-7-experiment-instrumentation`; não precisa de
alteração para esta preparação offline de protocolo/análise.
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

**Preparação da #8 implementada:** protocolo/modelo de ameaça e 13 cenários,
calendário preliminar balanceado, planilha externa de observação vazia e análise
Python reproduzível com tabelas/gráficos, manifesto e contrastes por etiqueta/sessão.
[Guia e limites](../experiments/README.md). Piloto/coleta principal requerem #12 e
protocolo/amostra fixados após o piloto. A #8 continua aberta; dados sintéticos
validam software, sem substituir resultados experimentais.

| Issue | Falta | Dependência para concluir |
| --- | --- | --- |
| [#12](https://github.com/Joao-AugustoPF/nfc-trace-api/issues/12) | Administração/personalização/secure messaging, proteção reversível, recuperação, perfil definitivo e aceite NTAG | Hardware real e implementação/procedimento físico restante |
| [#8](https://github.com/Joao-AugustoPF/nfc-trace-api/issues/8) | Piloto real, protocolo/amostra final, coleta/análise física e validade; preparação de software pronta | #12; instrumentação #7 disponível |
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
integração e reprodução final. #8 tem protocolo/análise preliminares implementados;
#12 ainda precisa da administração/aceite físico NTAG 424 DNA.

## Verificação da preparação #8

- 27 testes Python: denominadores, falhas/exclusões, ground truth revisado, pendências,
  clock reiniciado, marcadores ausentes, peso igual por etiqueta, pares por sessão,
  limite de bootstrap, integridade e gráficos/manifesto. Dependências em venv local.
- 122 testes API/11 suítes com PostgreSQL real; lint/fronteiras, tipos, build,
  formatter e geração OpenAPI (sem alteração do contrato).
- Calendário candidato: 540 tarefas/54 células, seis ordens balanceadas; nenhum
  UUID físico fabricado e planilha do observador vazia.
- Análise dos 43 roteiros sintéticos #7: 27 artefatos com checksum, zero leituras
  físicas e 129 medidas ausentes/censuradas identificadas. Sem erro de medição;
  intervalos não produzidos para blocos incompletos. Gráficos conferidos localmente.
- Sem nova instalação/build mobile, EAS, Actions ou merge. Workflow continua manual
  e desativado; passos Python só rodarão se alguém habilitar e solicitar execução.

Partes independentes seguintes: reprodução/material técnico #9 e administração NFC
#12. Piloto real/protocolo final/amostra/coleta da #8 continuam pendentes; o piloto
preliminar não fornece inferência ou resultado comparativo do TCC.
