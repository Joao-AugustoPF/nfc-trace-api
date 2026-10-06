# Entregas publicadas e trabalho restante

Atualização de 6 de outubro de 2026, aprovada pelo mantenedor. A branch de trabalho
nos dois repositórios é `codex/issue-1-sdm-bench-profile`.

## Software entregue

| Issue | Resultado disponível |
| --- | --- |
| [#1](https://github.com/Joao-AugustoPF/nfc-trace-api/issues/1) | Adaptador NFC, sessão exclusiva, leitura/gravação UID/NDEF, diagnóstico Type 4/permissões, bytes originais e perfil SDM candidato offline |
| [#2](https://github.com/Joao-AugustoPF/nfc-trace-api/issues/2) | Cliente/API reais, pedidos, busca, provisionamento/ativação, encerramento/nova época, cinco eventos operacionais e histórico/decisões; PROVISIONAMENTO gerado pela ativação |
| [#3](https://github.com/Joao-AugustoPF/nfc-trace-api/issues/3) | Autenticação, autorização, autoria verificada separada das declarações, login/restauração/revogação/logout e SecureStore no Expo |

O mantenedor aprovou as implementações para publicação. As issues acima registram
o software concluído, com critérios físicos transferidos explicitamente para
[#12](https://github.com/Joao-AugustoPF/nfc-trace-api/issues/12). Aprovação de código
não representa teste de NFC real ou revisão independente do outro integrante.

Os commits são publicados na branch e oferecidos em PRs; não houve merge na main.
A integração dos PRs e o aceite da versão exata de entrega permanecem em #9. Esta
regra de publicação substitui a exigência antiga de aguardar merge para encerrar
as issues de software, conforme autorização do mantenedor nesta atualização.

## Somente trabalho restante

| Issue | Falta entregar | Pré-requisito pendente |
| --- | --- | --- |
| [#12](https://github.com/Joao-AugustoPF/nfc-trace-api/issues/12) | Personalização autenticada/secure messaging, proteção reversível por chave, recuperação, perfil físico definitivo e aceite NTAG 424 DNA/UID/NDEF/SDM | Hardware real e implementação administrativa restante |
| [#5](https://github.com/Joao-AugustoPF/nfc-trace-api/issues/5) | Verificador SDM na API, referências/versões de chave por época, consumo/contadores concorrentes e políticas estrita/tardia | #12 |
| [#4](https://github.com/Joao-AugustoPF/nfc-trace-api/issues/4) | Fila local transacional, recuperação após reinício, cache seguro de vínculos, sincronização e lote | #5; fluxo online #2 já entregue |
| [#6](https://github.com/Joao-AugustoPF/nfc-trace-api/issues/6) | Reavaliação de eventos fora de ordem, decisões versionadas e histórico de pendências | #4 |
| [#7](https://github.com/Joao-AugustoPF/nfc-trace-api/issues/7) | Instrumentação, CSV/JSON, validação de integridade e cenários reproduzíveis | #6 |
| [#8](https://github.com/Joao-AugustoPF/nfc-trace-api/issues/8) | Piloto, coleta controlada e análise dos três tratamentos | #7 |
| [#9](https://github.com/Joao-AugustoPF/nfc-trace-api/issues/9) | Integração/reprodução final, versões identificadas, instalação limpa e material do TCC | #8 |

```mermaid
flowchart LR
  H["#12 NTAG 424 DNA"] --> S["#5 SDM na API"]
  S --> O["#4 Offline"]
  O --> R["#6 Reconciliação"]
  R --> I["#7 Instrumentação"]
  I --> E["#8 Experimentos"]
  E --> F["#9 Entrega final"]
```

Não criar issues menores para etapas já incluídas nessas entregas. O
[plano #10](https://github.com/Joao-AugustoPF/nfc-trace-api/issues/10) mantém as
sub-issues e dependências nativas do GitHub.

## Verificação desta publicação

- API: 70 testes em 6 suítes, PostgreSQL real/Supertest, lint com 8 verificações
  arquiteturais, tipos, formatação, build e OpenAPI.
- Mobile: 203 testes em 22 suítes, lint, tipos e exportação local do bundle iOS.
- Aceite anterior de autenticação: APK Android/SecureStore em emulador contra API
  real, três perfis, restauração, logout, indisponibilidade e revogação.
- Fixtures de protocolo/ponte nativa são identificadas como sintéticas. Somente a
  Feiju está disponível; não houve aceite NTAG 424 DNA ou mensagens físicas SDM.
- Workflows continuam somente `workflow_dispatch` e desativados no GitHub. Não
  executar Actions, build EAS ou merge como consequência desta publicação.

Os guias históricos 05 a 09 no Nova-tag preservam os resultados de cada etapa;
seus antigos estados de issue/branch não substituem esta situação atual. Valores
de chave, contas privadas, tokens, `.env`, `.tmp`, builds e evidências privadas
continuam fora do Git.
