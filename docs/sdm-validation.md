# SDM: verificação, épocas e gestão de chaves — #5

Entrega de software em `codex/issue-5-sdm-validation`, sobre a entrega offline #4.
O perfil **candidato** `nfc-trace.sdm.encrypted-picc.v1` corresponde ao gerador do Nova-tag.
Mensagens físicas, personalização administrativa, secure messaging e proteção de escrita
continuam na [#12](https://github.com/Joao-AugustoPF/nfc-trace-api/issues/12). Somente a
Feiju está disponível; esta entrega não a identifica como NTAG 424 DNA.

## Perfil e verificador

URI única, com UUID minúsculo do provisionamento emitido pelo servidor:

```text
urn:nfc-trace:sdm:v1:<uuid>?picc_data=<32 hex>&cmac=<16 hex>
```

`leituraBruta.ndef` deve ser a URI exata dos bytes originais; `bytesBase64` deve conter
**127 bytes** de uma única mensagem NDEF URI curta, sem compressão, NLEN ou status APDU.
Cabeçalho `D1017B5500`. Hexadecimal espelhado pode ser maiúsculo ou minúsculo, mas os
bytes ASCII são preservados no cálculo do MAC. Não há trim, normalização desses campos,
reconstrução de evidência, parâmetros extras, LRP ou outro layout aceito implicitamente.

| Campo | Offset no arquivo com NLEN | Offset na mensagem enviada | Tamanho |
| --- | --- | --- | --- |
| PICC cifrado ASCII | 75 | 73 | 32 bytes ASCII |
| Início do MAC | 7 | 5 | URI até `&cmac=` inclusive |
| MAC truncado ASCII | 113 | 111 | 16 bytes ASCII |

O adaptador Node usa AES-128-CBC com IV zero, sem padding, para recuperar PICC tag `C7`,
UID de sete bytes, contador de três bytes little-endian e cinco bytes de padding aleatório.
A sessão MAC deriva de AES-CMAC sobre `3CC300010080 || UID || contadorLE`, com a chave
FileRead da época. O MAC cobre `message[5:111]`; sua truncagem mantém índices 1,3,...,15.
Comparações de MAC e UID autenticado usam `timingSafeEqual`. A UID recuperada do PICC deve
corresponder à etiqueta cadastrada; a UID declarada pelo leitor é separada e sua divergência
produz aviso/SUSPEITO, sem substituir a autenticação nem selecionar outro tratamento.

Referência: [NXP AN12196 Rev. 2.0 (4/3/2025), seções 3.3–3.4](https://www.nxp.com/docs/en/application-note/AN12196.pdf).
Primitivas são testadas independentemente do perfil do projeto, com valores esperados:

| Origem | Entrada resumida | Resultado esperado |
| --- | --- | --- |
| NXP tabela 1 | FileRead `5ACE7E50AB65D5D51FD5BF5A16B8205B`, UID `04C767F2066180`, contadorLE `010000` | sessão MAC `3A3E8110E05311F7A3FCF0D969BF2B48`; sessão ENC `66DA61797E23DECA5D8ECA13BBADF7A9` |
| NXP tabela 2 | MetaRead pública zero; PICC `EF963FF7828658A599F3041510671E88` | `C704DE5F1EACC0403D0000DA5CF60941`; contador 61 |
| NXP tabela 4 | FileRead pública zero, UID/contador da tabela 2; entrada MAC vazia | sessão `3FB5F6E3A807A03D5E3570ACE393776F`; MACt `94EED9EE65337086` |
| NXP tabela 5 | PICC `FD91EC264309878BE6345CBE53BADF40`; entrada ASCII `CEE9A53E3E463EF1F459635736738962&cmac=` | sessão `3ED0920E5E6A0320D823D5987FEAFBB1`; MACt `ECC1E7F6C6C73BF6` |

AES-CMAC também confere os [exemplos oficiais AES128 do NIST](https://csrc.nist.gov/CSRC/media/Projects/Cryptographic-Standards-and-Guidelines/documents/examples/AES_CMAC.pdf),
com entradas de 0,16,20,64 bytes (incluindo último bloco incompleto).
O [exemplo de layout](sdm-profile-v1.example.json) tem placeholders públicos, **não** é
leitura autenticada. `test/sdm-fixtures.ts` fabrica mensagens sintéticas; não atribuí-las
à NXP, a uma tag real ou ao aceite físico. O teste compara o layout público do mobile
com o verificador. Ajuste constatado na bancada exige novo perfil, nova época e contrato explícito.

## Provisionamento e ativação

Administrador inicia por `POST /api/v1/etiquetas`:

```json
{
  "pedidoId": "00000000-0000-4000-8000-000000000001",
  "uid": "04AABBCCDDEE01",
  "modelo": "NTAG424DNA",
  "estrategia": "SDM",
  "politicaSdm": "REGISTRO_TARDIO"
}
```

A política é obrigatória; SDM exige UID de sete bytes. Modelo é uma declaração,
não certificação do chip. Servidor atribui UUID, época e material novo de chaves,
mesmo ao reutilizar uma etiqueta. Perfil/política/referência/versão e identidade
do vínculo são imutáveis, também por constraints/triggers no PostgreSQL.
Cliente não envia época, perfil, contador, chave ou política por captura.

Resposta pública `sdm`: `perfil`, `perfilCandidato`, `politica`, `referenciaChaves`,
`versaoChaves:1`, `metaReadSlot:1`, `fileReadSlot:2`, `uriTemplate` com placeholders.
Ela não inclui material de chave. `referenciaNdef` estática permanece null para SDM.

Após personalização física externa, ativar com `bloqueioConfirmado:true` e
`leituraSdm:{uid,ndef,bytesBase64}`. Uma leitura criptograficamente válida é
obrigatória na primeira ativação. Sua evidência fica consumida pela ativação e
não pode movimentar um pedido depois. Prova inválida, falha física ou rollback
mantém o vínculo REGISTRADA. Confirmação do vínculo já ATIVA é idempotente por ID;
não reaplica prova, contador, movimento ou evento. Bloqueio de escrita continua
declarado; MAC válido não demonstra que a escrita física está protegida.

Encerramento conserva chaves cifradas, contadores, evidências e histórico para
reprodução. Novo vínculo exige pedido CADASTRADO, nova época e novas chaves físicas.
Não existe endpoint para resetar contador ou mudar política/chaves de uma época.

## Reserva e políticas

Primeiro resolve o vínculo no servidor e bloqueia seu pedido; relê situação.
Vínculo inativo/desconhecido não consome evidência. Evidência inválida fica armazenada,
sem avançar contador. Autenticação válida reserva `(provisionamento,contador)`
para o UUID original, mesmo se a sequência logística rejeitar a operação.
PICC com padding diferente e mesmo contador também é reutilização.

| Condição após autenticação | ESTRITA | REGISTRO_TARDIO |
| --- | --- | --- |
| Contador novo acima do máximo | Avaliar regras logísticas | Avaliar regras logísticas |
| Contador inédito abaixo do máximo | Armazenar SUSPEITO / `SDM_CONTADOR_NAO_CRESCENTE` | Armazenar REGULAR (salvo avisos) / `SDM_REGISTRO_TARDIO` |
| Contador já reservado, outro UUID | `SDM_EVIDENCIA_REUTILIZADA` / sem movimento | Mesmo resultado |
| Mesmo UUID e conteúdo normalizado | Comprovante original | Comprovante original |
| Mesmo UUID e conteúdo diferente | 409 `IDEMPOTENCIA_CONFLITO` | Mesmo resultado |

Nenhuma leitura tardia produz movimento automaticamente. Máximo representa o
**maior contador autenticado**, não o último movimento aceito; nunca regride.
Políticas exigem novas épocas/ensaios separados para comparação, sem alternância
para permitir um replay. Contador é unsigned 24-bit; atingir limite exige nova
época/personalização, sem wrap ou reset lógico. Reavaliação futura #6 deve verificar
a reserva do **mesmo UUID**, sem consumir outra vez nem promover leitura tardia.

`decisao.sdm` separa `autenticada`, `previamenteUtilizada`, `contador`,
`maiorContadorAnterior`, `temporalidade`, `perfil`, `politica` e `epoca`.
`decisao.autorizada` continua sendo somente a decisão logística. Campos aparecem
em POST, consulta de evento, lote, histórico e evento interno de auditoria.
UID e NDEF estático mantêm as regras anteriores, sem tabela de consumo SDM.

Uma evidência válida guardada e apresentada pela primeira vez pode ser aceita.
Isso **não prova frescor**, presença atual ou horário de leitura. O MAC autentica
a URI/PICC do perfil; não autentica UUID da observação, tipo de evento, localização,
operador/dispositivo ou horário declarados. Autoria de sessão é uma garantia separada.

## Cofre e administração local

Cada época recebe dois AES128 aleatórios, MetaRead/FileRead, com referência UUID e
versão 1. A aplicação usa a porta `SdmCryptography`; domínio não importa Node,
TypeORM ou Nest. Chaves são guardadas somente cifradas em `sdm_keys`, AES256-GCM,
nonce aleatório, tag de autenticação e AAD que vincula provisionamento/perfil/ref/
versão de chave/versão mestra. Chave mestra de 32 bytes fica fora do banco e do app.

Para Node local:

```powershell
npm run sdm:keys -- generate-master --version 1 --output .tmp/private/sdm-master.env
# No .env local, definir somente este caminho; nunca copiar o segredo para Git:
# SDM_ENV_FILE=.tmp/private/sdm-master.env
npm run db:migrate
npm run start:dev
```

Arquivo privado é criado exclusivamente, sem sobrescrever. No Windows, remove
herança de ACL e concede acesso somente ao usuário corrente; POSIX usa modo 0600.
Saída no terminal mostra apenas o caminho. CLI não lê segredos como argumentos.
Diretório `.tmp/private` é ignorado por Git. `SDM_ENV_FILE` só fornece duas variáveis
SDM; não pode substituir URL do banco ou configurações HTTP. Variáveis inline
não vazias têm prioridade. Ausência do cofre não impede UID/NDEF; operações SDM
que precisam dele retornam 503 `SDM_CHAVES_INDISPONIVEIS`. A fila reenvia sem alterar
o payload. Wrapper indisponível/corrompido não é tratado como tag criptograficamente inválida.

Para containers, injetar `SDM_ACTIVE_MASTER_VERSION` e `SDM_MASTER_KEYS_JSON` por
gerenciador de segredos. O Compose aceita essas variáveis, mas não distribui ou
monta automaticamente o arquivo privado Windows; não há chave pública padrão.

Distribuição administrativa, somente para vínculo REGISTRADA:

```powershell
npm run sdm:keys -- export --provisioning-id <UUID> --output .tmp/private/tag-ensaio.json
```

O arquivo contém slots 1/2 e segredos, para transferência por canal administrativo
seguro à bancada. Não importar no app operacional, enviar por chat, commit ou
relatório público. Exportação é ação local auditada por referência (origem CLI_LOCAL),
sem material de chave. Arquivo não equivale a escrita, secure messaging ou instalação
da chave administrativa slot 0: essas implementações/procedimentos são #12.
Entrega do arquivo e transação de auditoria não são atomicamente coordenadas; se
o commit falhar depois da escrita, o arquivo privado pode existir. Conferir o
resultado/auditoria antes da distribuição, sem sobrescrever silenciosamente.

Rotação da **mestra do cofre** preserva chaves da tag, referências, contadores e épocas:

1. Gerar versão mestra nova em outro arquivo privado; guardar backup independente.
2. Preparar keyring privado contendo versões antigas e nova (`{"1":"<base64 privado>","2":"<base64 privado>"}`); definir ativa `2`.
3. Reiniciar os processos com ambas as versões legíveis. Executar `npm run sdm:keys -- rewrap`.
4. O comando bloqueia wrappers e reencifra todos em uma transação com outbox; falha faz rollback conjunto.
5. Conferir resultado/backup/restauração antes de retirar mestra antiga dos processos.

Rotação da **chave física**, reset ou reconfiguração usa encerramento/nova época,
nova referência e material aleatório, nunca rewrap. Recuperação restaura backup
do banco **com evidências/máximos** e as respectivas mestras de backup independente.
Não recuperar somente chaves nem regredir contadores. Perder mestra sem backup torna
essas chaves irrecuperáveis; encerre época e execute recuperação física autorizada
da #12. Apague arquivos de distribuição após instalação verificada segundo o
procedimento de bancada; descarte/retenção dos backups depende do roteiro do TCC.

## Validação e continuidade

`sdm-crypto.spec.ts`: NXP/NIST, layout do mobile, cofre por escopo, rotação/recuperação.
`test/sdm.spec.ts`: PostgreSQL/Supertest reais, prova de ativação, seis eventos,
replay entre UUIDs, oito capturas concorrentes, duas políticas, bytes/chaves alterados,
UID protegido divergente, rollback, encerramento/nova época, CLI e ausência de segredos
em respostas/auditoria. Fixtures do perfil são sintéticas. Teste explícito registra
primeira apresentação de evidência guardada com contexto arbitrário, sem alegar frescor.

Mobile: resolução SDM por ID, bytes originais, cache/fila SQLite por época, retry 503,
recuperação após fechar banco e apresentação de autenticação/uso/política separada da
movimentação. A reconciliação de decisões pendentes/versionadas é a próxima #6.
O development build iOS ainda precisa dos módulos SQLite/rede da #4; nenhum novo
EAS ou GitHub Actions foi iniciado. Não há SDK criptográfico/segredo novo no mobile.
