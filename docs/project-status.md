# Entregas publicadas e trabalho restante

Atualização de 7 de outubro de 2026. API:
`codex/issue-12-secure-messaging`, sobre `codex/issue-9-reproducibility`.
Mobile usa `codex/issue-9-reproducibility`, sobre a instrumentação #7.
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
| [#12](https://github.com/Joao-AugustoPF/nfc-trace-api/issues/12) | Motor EV2 disponível; faltam cofre/diário/API/tela administrativos, personalização, proteção/recuperação, perfil definitivo e aceite NTAG | Hardware real e integração de código/procedimento restantes |
| [#8](https://github.com/Joao-AugustoPF/nfc-trace-api/issues/8) | Piloto real, protocolo/amostra final, coleta/análise física e validade; preparação de software pronta | #12; instrumentação #7 disponível |
| [#9](https://github.com/Joao-AugustoPF/nfc-trace-api/issues/9) | Integração autorizada, reprodução pelo colega, APK/builds/perfil/corpus definitivos e material final; preparação técnica disponível | #8 e aceites físicos transitivos |

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

Preparação publicada em [API #18](https://github.com/Joao-AugustoPF/nfc-trace-api/pull/18),
sobre [#17](https://github.com/Joao-AugustoPF/nfc-trace-api/pull/17), implementação
`da861f1`. A branch mobile e o PR #6 permanecem iguais. #8/#9/#10/#12 continuam
abertas, com aceite físico e integração final explicitamente pendentes.

## Preparação técnica da #9

[Guia de reprodução](reproduction.md), manifesto candidato API/mobile/APK/dataset,
hashes de fonte/dependências/build carregado (`/health/version`), procedimento de
backup privado/restauração em banco novo e matriz objetivo→software→evidência restante.
Guia e README mobile atualizados; estados anteriores de offline/reconciliação corrigidos.

Verificado localmente: 126 testes API/13 suítes (v1 populada→atual preservando
histórico/épocas/outbox), 241 mobile/24 suítes, lint/tipos/build/formatter; APK Android
0.3.0/3 compilado com bundle embutido, configuração/source hash conferidos.
Reprodução Docker própria com instalação `npm ci`, cinco migrations, seed repetido,
UID/NDEF/seis movimentos/reenvio HTTP, 10 capturas/12 movimentos, backup e restore
de 24 tabelas com hashes idênticos e worker real retomando 34 registros de auditoria.
Após restauração, os dez reenvios retornaram os recibos originais, sem novo efeito;
trigger de imutabilidade e sequência de migrations também foram conferidos.
O APK foi instalado em emulador Android e abriu o login sem Metro, sem erro fatal.
São fixtures HTTP, zero leituras físicas. O cofre externo SDM não foi restaurado
por esse ensaio e não está no dump. Nenhum EAS/Actions/merge iniciado.

A preparação não fecha #9: colega ainda precisa reproduzir versões finais; integração
na main não ocorreu; #12/#8 ainda exigem hardware, procedimentos e resultados.

## Publicação da preparação #9

- [API #19](https://github.com/Joao-AugustoPF/nfc-trace-api/pull/19), sobre [#18](https://github.com/Joao-AugustoPF/nfc-trace-api/pull/18), implementação `6774450`.
- [Nova-tag #7](https://github.com/brunoaiolfi/Nova-tag/pull/7), sobre [#6](https://github.com/brunoaiolfi/Nova-tag/pull/6), implementação `9474d35`.

Build API e APK recompilados após esses commits, sem mudanças rastreadas; manifesto
local confirmou fonte correspondente ao checkout e revisão embutida no APK.
APK 0.3.0/3: SHA-256 `cdf486e69dc56f6d7fe6a451a50b7e79153c8ac20034775640b835b46797425e`.
Log Gradle/manifestos ficam em `.tmp/delivery`, fora do Git; pacote instalado em
emulador, não aceite NFC. A cadeia de PRs segue aberta, sem merge ou Actions/EAS.
Próximo trabalho independente: administração/personalização/secure messaging #12;
NTAG física ainda é necessária para concluir o aceite e o piloto #8.

## Motor de secure messaging da #12

[Protocolo e sequência de integração](ntag-administration.md): AuthenticateEV2First/
NonFirst, MAC/FULL, UID autenticado antes de mutações, permissões recuperáveis,
ChangeKey/CRC, contador e interrupção com efeito físico desconhecido. AES-CMAC é
compartilhado com o verificador SDM. Vetores NXP de autenticação/derivação/IV/CFS/
ChangeKey conferidos; 20 testes novos, 146 API/14 suítes com PostgreSQL/Supertest,
lint/8 fronteiras, tipos, formatter, build e OpenAPI sem alteração de contrato.

Esta etapa é o motor de protocolo, ainda sem endpoint/tela/diário/cofre dos cinco
slots administrativos. Não personaliza a tag pelo aplicativo. Continuar na mesma
#12 com inventário privado, operação durável, API administrativa e transporte NFC
real no mobile; depois executar proteção/recuperação e o aceite físico. Nenhum
checkbox de personalização completa ou bancada foi concluído. Mobile não mudou;
nenhum EAS, Actions ou merge iniciado.
