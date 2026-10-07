"""Deterministic tables and standard matplotlib figures; no network or app access."""

import csv
import hashlib
import json
from pathlib import Path


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2) + "\n",
                          encoding="utf-8")


def write_csv(path, rows, fields=None):
    keys = fields or list(dict.fromkeys(key for row in rows for key in row))
    with Path(path).open("w", newline="", encoding="utf-8-sig") as stream:
        writer = csv.DictWriter(stream, fieldnames=keys)
        writer.writeheader()
        for row in rows:
            values = {}
            for key in keys:
                value = row.get(key)
                if isinstance(value, (dict, list)):
                    value = json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True)
                # JSON remains authoritative; formula protection is only CSV presentation.
                if isinstance(value, str) and value.lstrip().startswith(("=", "+", "-", "@", "\t", "\r")):
                    value = "'" + value
                values[key] = value
            writer.writerow(values)


def figures(folder, report):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 9,
                         "svg.hashsalt": "nfc-trace-analysis-v1"})
    label = ("CONTROLE SINTÉTICO — SEM LEITURA FÍSICA" if report["dataKind"] == "SINTETICO"
             else "DADOS DECLARADOS FÍSICOS — CONFERIR PROCEDÊNCIA")
    outputs = []
    groups = report["groups"]
    for page, start in enumerate(range(0, len(groups), 16), 1):
        rows = groups[start:start + 16]
        fig, axes = plt.subplots(1, 3, figsize=(14, max(4, len(rows) * .4)), sharey=True)
        labels = [f'{r["scenario"]} | {r["treatment"]}/{r["policy"] or "—"}\n'
                  f'{r["deviceId"]} | {r["mode"]}' for r in rows]
        for axis, name, title in zip(axes, ("readSuccess", "falseAcceptance", "falseRejection"),
                                     ("Sucesso de leitura física", "FAR operacional por cenário", "FRR operacional por cenário")):
            for index, row in enumerate(rows):
                item = row["rates"][name]
                if item["value"] is not None:
                    axis.scatter(item["value"] * 100, index, color="#2956c7")
                    axis.text(min(102, item["value"] * 100 + 2), index,
                              f'{item["numerator"]}/{item["denominator"]}', va="center", fontsize=7)
                else:
                    axis.text(2, index, "sem denominador", va="center", color="#666", fontsize=7)
            axis.set_title(title)
            axis.set_xlim(-3, 124)
            axis.set_xticks([0, 25, 50, 75, 100])
            axis.set_xlabel("% descritiva; nenhuma barra de IC binomial")
            axis.grid(axis="x", alpha=.2)
        axes[0].set_yticks(range(len(rows)), labels)
        axes[0].invert_yaxis()
        fig.suptitle(label + "\nTentativas dependentes; pendências/falhas/exclusões nas tabelas", fontsize=11)
        fig.tight_layout()
        for extension in ("png", "svg"):
            name = f"rates-{page:02d}.{extension}"
            fig.savefig(folder / name, dpi=160, metadata={"Date": None} if extension == "svg" else {})
            outputs.append(name)
        plt.close(fig)
    # ECDF is conditional on completed durations; failure stages remain separate.
    groups = {}
    for row in report["durations"]:
        if row["ms"] is None or row["excluded"]:
            continue
        key = (row["source"], row["boundary"], row["stage"], row["revision"])
        condition = (row["scenario"], row["treatment"], row["policy"], row["mode"], row["deviceId"])
        groups.setdefault(key, {}).setdefault(condition, []).append(row["ms"])
    for index, (boundary, conditions) in enumerate(sorted(groups.items(), key=lambda x: str(x[0])), 1):
        fig, axis = plt.subplots(figsize=(11, 6))
        for condition, values in sorted(conditions.items(), key=lambda x: str(x[0])):
            ordered = sorted(values)
            axis.step(ordered, [(i + 1) / len(ordered) for i in range(len(ordered))], where="post", marker=".",
                      label=" | ".join(str(v) for v in condition) + f" (n={len(ordered)})")
        axis.set_xlabel("Duração medida na mesma origem monotônica (ms)")
        axis.set_ylabel("Proporção acumulada das durações disponíveis")
        axis.set_ylim(0, 1.04)
        axis.set_title(label + "\n" + " | ".join(str(v) for v in boundary))
        axis.grid(alpha=.2)
        axis.legend(fontsize=6, loc="center left", bbox_to_anchor=(1, .5))
        fig.tight_layout()
        for extension in ("png", "svg"):
            name = f"durations-{index:02d}.{extension}"
            fig.savefig(folder / name, dpi=160, metadata={"Date": None} if extension == "svg" else {})
            outputs.append(name)
        plt.close(fig)
    return outputs


def markdown(report):
    counts = report["totals"]
    return f"""# Análise descritiva NFC Trace

Origem declarada: **{report['dataKind']}**. Estado: **{report['status']}**.
Execução: `{report['runId']}`. Versão: `{report['analysisVersion']}`.

{'**CONTROLE SINTÉTICO: não constitui piloto, coleta física ou resultado do TCC.**' if report['dataKind'] == 'SINTETICO' else '**Procedência física declarada: conferir aceite, corpus e registro externo do observador.**'}

- Roteiros: {counts['planned']}; ainda não iniciados: {counts['unstarted']}.
- Leituras físicas elegíveis: {counts['physicalReadSuccess']}/{counts['physicalReadAttempts']}.
- Capturas locais/armazenadas: {counts['localCaptures']}/{counts['storedLocal']}.
- Confirmações locais sem servidor: {counts['confirmedLocalWithoutServer']} (não prova perda local).
- Autorizadas: {counts['authorized']}; rejeitadas: {counts['rejected']}; tardias: {counts['late']}; pendentes: {counts['pending']}.
- Autenticadas SDM: {counts['authenticated']}; evidências previamente utilizadas: {counts['previouslyUsed']}.
- Ground truth ausente: {counts['truthMissing']}; excluídas: {counts['excluded']}.
- Efeitos adicionais por UUID: {counts['duplicateEffects']}.

`groups.csv` mantém cenário, modo, tratamento, política e aparelho. FAR/FRR usam somente
ground truth elegível e capturas armazenadas. Pendências estão no denominador e são
reportadas separadamente; nenhuma fração provisória é conclusão definitiva.
`trials.csv` preserva todas as linhas, falhas e exclusões. `blocks.csv` mantém etiqueta,
aparelho e sessão; `contrasts.csv` dá o mesmo peso a cada etiqueta, depois da média dos
blocos pareados. Pareamento nominal não certifica controles/épocas equivalentes.

Medianas/IQR/p95 descrevem durações concluídas, separadas por fronteira, estágio e
revisão; censuras aparecem em `timings.csv`. NFC é a sessão SDK completa, não rádio puro.
Sem subtração de relógios de hosts diferentes. Gráficos ECDF são condicionais às medidas
disponíveis, não incorporam timeout como sucesso lento.

Incerteza, quando solicitada, é **exploratória**, condicional aos aparelhos fixos:
reamostra etiquetas inteiras com sessões e diferenças pareadas preservadas. Não há
p-valores, amostra final, alegação de equivalência ou prova de frescor/vínculo à caixa.
Poucos clusters e falta de variação suprimem o intervalo; ausência de falhas não prova
taxa zero. O limite mínimo de clusters é um guardrail preliminar, não teorema.

`manifest.json` identifica fontes, código/plano e artefatos por SHA-256. Checksum não
é assinatura. O bundle original continua em `original-bundle.json`; não publicar dados
pessoais, coordenadas reais, credenciais ou chaves. Esta ferramenta não os anonimiza.
"""
