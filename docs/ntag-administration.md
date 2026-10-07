# Administração NTAG 424 DNA — implementação progressiva da #12

Branch `codex/issue-12-secure-messaging`, sobre a preparação de reprodução #9.
Nesta etapa foi implementado o **motor de protocolo EV2 no servidor**. Ainda não
há endpoint administrativo, importação de credenciais físicas, diário durável de
personalização ou tela de bancada no Nova-tag. Não é possível usar este incremento
sozinho para personalizar uma tag pelo aplicativo. A #12 permanece aberta, com
trabalho de código e de bancada; somente a Feiju está disponível.

## Protocolo implementado

`src/platform/nfc/ev2.ts` implementa uma sessão RF: AuthenticateEV2First/NonFirst,
derivação de chaves, contador/TI, envelopes MAC/FULL, GetCardUID, GetFileSettings,
GetKeyVersion, ReadData/WriteData, ChangeFileSettings e ChangeKey. O adaptador
`NodeEv2Cryptography` usa Node crypto no servidor, sem módulo/chave novo no mobile.
AES-CMAC agora está em `platform/cryptography`, compartilhado com o verificador SDM;
o contrato SDM mantém seus vetores e comportamento anteriores.

Referências primárias: [datasheet NXP Rev. 3.0, §§9.1/10](https://www.nxp.com/docs/en/data-sheet/NT4H2421Gx.pdf)
e [AN12196 Rev. 2.0, tabelas 14/18/23/25/26](https://www.nxp.com/docs/en/application-note/AN12196.pdf).
Os testes usam constantes públicas dessas tabelas para autenticação, derivação,
IV, ChangeFileSettings e os dois casos de ChangeKey, comparando bytes completos.
Os demais casos são respostas sintéticas identificadas, não mensagens físicas.

- Autenticação usa AES128-CBC com IV zero e sem padding. A confirmação valida
  desafio rotacionado e eco de capacidades; não aceita LRP/fallback implícito.
- Comandos usam contador atual; respostas usam contador incrementado. MAC é
  conferido antes de liberar dados decifrados. Padding Method 2 sempre acrescenta
  80h/zeros, inclusive bloco adicional para dados múltiplos de 16.
- CRC de ChangeKey usa o estado acumulado, sem complemento final, e saída little
  endian: a chave pública da tabela 25 produz `789DFADC`, não o CRC pós-complemento
  usual de outras bibliotecas. XOR da chave antiga só é usado nos slots 1–4.
- SW1/SW2 são os dois últimos bytes da APDU recebida. Na tabela 18 da application
  note a linha da resposta inverte a apresentação do status/MAC; o teste usa o
  formato wrapped APDU do datasheet. Não copiar essa ordem textual para o SDK.
- NonFirst conserva TI/contador e troca as chaves de sessão. Não renova o limite
  de comandos. Por padrão são 128 comandos por sessão; nunca há wrap do contador.

## Invariantes do motor

Autenticar com slot 0 não autoriza escrita por si só. `confirmUid(expectedUid)`
precisa comparar o UID obtido em resposta FULL autenticada antes de qualquer
mutação. `uid()` somente consulta e não habilita escrita. Outros slots autenticados
podem consultar; mutações exigem slot 0. Não há tentativa automática de chave zero,
reenvio de APDU ou mudança de tratamento após falha.

Há um comando pendente por vez. MAC/status/comprimento/padding inválidos encerram
o canal, sem prosseguir. `interrupt()` encerra e indica se uma mutação emitida pode
ter efeito físico desconhecido. Erros após resposta incompleta/corrompida de uma
mutação retornam `physicalOutcome: NAO_CONFIRMADO`; não presumir que nada foi gravado.

WriteData usa quadros pequenos, no máximo 128 bytes por trecho, respeitando arquivos
CC/NDEF/proprietário. A sequência de gravação de NLEN pertence ao plano pendente.
ChangeFileSettings preserva alteração/escrita por slot 0,
recusa ReadWrite livre, permissão administrativa F e bits/modos reservados. O motor
não expõe SetConfiguration para conversão irreversível para LRP, RandomID ou limites
de falha de autenticação. Formato/offsets/permissões finais ainda serão determinados
pelo plano autoritativo, não por parâmetros arbitrários de HTTP.

ChangeKey do slot 0 encerra autenticação e recebe ACK sem MAC. O recibo marca
`responseAuthenticated:false` e `reauthenticationRequired:true`; isso **não prova**
que a nova chave foi instalada. Outra sessão deve autenticar com o material novo,
confirmar UID/versões/configuração e recuperar ambiguidades antes de concluir.

Chaves/desafios/sessão ficam em campos privados e não aparecem em JSON/inspeção
ordinária. Buffers pertencentes ao canal são zerados ao encerrar; buffers do chamador
não são modificados. Isso é limpeza em memória por melhor esforço, não memória
protegida nem garantia de apagamento de todas as cópias internas do runtime/OpenSSL.
O chamador deve fechar o canal em cancelamento/expiração/falha de transporte.

## Próxima integração da mesma #12

A decisão arquitetural é manter criptografia e material privado no servidor.
O mobile será transporte APDU em uma sessão administrativa separada, usando sua
ponte NFC real. Essas partes **ainda devem ser implementadas**, na ordem:

1. Inventário/cofre dos cinco slots e versões físicas, importação administrativa
   local auditada, referências atuais/alvo recuperáveis e plano derivado do vínculo
   REGISTRADA. Chaves MetaRead/FileRead existentes da #5 seguem por época; a chave
   administrativa e slots não usados também precisam de gestão explícita.
2. Operação e diário duráveis, com intenção registrada antes de emitir cada mutação,
   exclusão por tag/vínculo, administrador/aparelho, expiração e tratamento de ACK
   perdido/reinício. Nenhuma transação PostgreSQL abrange o efeito físico NFC.
3. API ADMINISTRADOR para início/etapas/consulta/recuperação, sempre ligada a UID,
   época, plano e sessão; resposta transporta comando cifrado, nunca chaves privadas.
   Falha de autorização, vínculo encerrado ou estação concorrente impede continuação.
4. Tela de bancada isolada no Nova-tag: identificação compatível antes de comando
   específico, sessão NFC exclusiva, progresso persistente, confirmação de plano,
   cancelamento e recuperação. A Feiju continua incompatível com este protocolo.
5. Aplicar plano protegido: confirmar UID; NLEN zero; gravação em trechos; leitura
   estática autenticada; NLEN final/perfil; conferir configurações; slot 0 por último
   e reautenticar. Leitura FULL depende do direito de leitura atual: usar configuração
   temporária que exige slot 0; não tratar leitura livre ISO como prova autenticada.
6. Nova sessão RF para leitura dinâmica e ativação existente, sem reset automático
   ou ativação apenas pelo ACK. Reconfiguração de época ATIVA exige encerramento/nova
   época; recuperação parcial de uma operação pendente deve conservar seu alvo.

TLS e conta administrativa continuam necessários no transporte HTTP. Um MAC válido
na configuração autentica a conversa com a chave correspondente; não certifica
originalidade do chip, verdade logística ou proteção física sem teste negativo.
Chave de transporte conhecida/publicamente disponível não prova originalidade.

## Evidência desta etapa

20 testes EV2 com vetores NXP e casos adversariais/sintéticos; suíte completa API:
146 testes/14 suítes com PostgreSQL real/Supertest. Lint/8 fronteiras, tipos,
formatter, build e OpenAPI passaram; contrato HTTP permanece igual. Os testes
conferem UID divergente, capacidades, padding alinhado, replay, contador, concorrência,
permissões recuperáveis, slot 0, ACK perdido, limpeza de buffers e serialização.

Não houve personalização, leitura NFC física, tela/endpoint novo, firmware, EAS,
GitHub Actions ou merge. Builds móveis e seus aceites anteriores permanecem na #9.
O material final e o piloto continuam dependentes de implementação/aceite #12 e #8.
