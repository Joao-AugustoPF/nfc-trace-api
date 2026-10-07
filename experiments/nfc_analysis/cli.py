"""CLI with immutable input, canonical TypeScript validation and new output directory."""

import argparse
import hashlib
import json
from pathlib import Path
import platform
import importlib.metadata
import shutil
import subprocess
import sys
import tempfile

from . import VERSION
from .analysis import COUNT_FIELDS, contrasts, facts, reconciliation, summarize, timing_summary
from .planner import schedule
from .reporting import digest, figures, markdown, write_csv, write_json

ROOT = Path(__file__).resolve().parents[2]


def validate(raw):
    node = shutil.which("node")
    if not node:
        raise ValueError("Node.js 24 é necessário para validar o contrato/checksum canônico.")
    # Validate exactly the bytes subsequently analyzed; a source changing during
    # export/analysis cannot race the validator's independent filesystem read.
    with tempfile.TemporaryDirectory(prefix="nfc-analysis-") as name:
        path = Path(name) / "frozen-bundle.json"
        path.write_bytes(raw)
        process = subprocess.run([node, str(ROOT / "scripts/experiment-data.cjs"), "validate", str(path)],
                                 cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=90)
    if process.returncode:
        raise ValueError("Bundle inconsistente ou checksum divergente. Execute experiment:data validate para diagnóstico.")
    return json.loads(process.stdout)["integrity"]


def validate_analysis_plan(plan):
    if plan.get("schemaVersion") != 1 or plan.get("status") != "PRELIMINAR" or not plan.get("version"):
        raise ValueError("Plano de análise preliminar inválido.")
    b = plan.get("bootstrap", {})
    if (type(b.get("replicates")) is not int or not 500 <= b["replicates"] <= 100000
            or type(b.get("minimumTags")) is not int or b["minimumTags"] < 12
            or type(b.get("seed")) is not int or b.get("interval") != [.025, .975]):
        raise ValueError("Configuração de bootstrap inválida; mínimo preliminar de 12 etiquetas.")
    metrics = {"readSuccess", "falseRejection", "falseAcceptance", "preservation", "INICIO_ATE_CONFIRMACAO_LOCAL"}
    conditions = {"UID", "NDEF_ESTATICO", "SDM:ESTRITA", "SDM:REGISTRO_TARDIO"}
    if not isinstance(plan.get("contrasts"), list) or any(
        c.get("metric") not in metrics or c.get("left") not in conditions or
        c.get("right") not in conditions or c["left"] == c["right"] or not c.get("scenario")
        for c in plan["contrasts"]
    ):
        raise ValueError("Contrastes planejados inválidos.")


def analyze(args):
    source = args.input.resolve(strict=True)
    raw = source.read_bytes()
    integrity = validate(raw)
    bundle = json.loads(raw.decode("utf-8-sig"))
    dataset = bundle["dataset"]
    plan_path = args.plan.resolve(strict=True)
    plan = json.loads(plan_path.read_text(encoding="utf-8-sig"))
    validate_analysis_plan(plan)
    trials, durations, measurement_issues = facts(dataset)
    comparison, blocks = contrasts(trials, durations, plan, args.bootstrap)
    run = dataset["run"]["input"]
    report = {
        "schemaVersion": 1, "analysisVersion": VERSION, "runId": run["id"],
        "dataKind": run["dataKind"], "protocolVersionDeclared": run["protocolVersion"],
        "status": "CONTROLE_SINTETICO" if run["dataKind"] == "SINTETICO" else "DESCRITIVO_PRELIMINAR",
        "integrity": integrity, "measurementIssues": measurement_issues,
        "totals": {field: sum(r[field] for r in trials) for field in COUNT_FIELDS},
        "trials": trials, "groups": summarize(trials), "durations": durations,
        "timings": timing_summary(durations), "contrasts": comparison, "blocks": blocks,
        "reconciliation": reconciliation(dataset),
    }
    # All validation/computation precedes output creation; never overwrite input/output.
    folder = args.output.resolve()
    folder.mkdir()
    (folder / "original-bundle.json").write_bytes(raw)
    shutil.copyfile(plan_path, folder / "analysis-plan.json")
    write_json(folder / "analysis.json", report)
    for name in ("trials", "durations", "timings", "contrasts", "blocks", "reconciliation"):
        write_csv(folder / (name + ".csv"), report[name], fields=None if report[name] else ["noRows"])
    flat_groups = []
    for row in report["groups"]:
        flat = {key: value for key, value in row.items() if key != "rates"}
        for metric, values in row["rates"].items():
            for field, value in values.items():
                flat[metric + "_" + field] = value
        flat_groups.append(flat)
    write_csv(folder / "groups.csv", flat_groups)
    (folder / "report.md").write_text(markdown(report), encoding="utf-8")
    if not args.no_plots:
        figures(folder, report)
    tracked = sorted((ROOT / "experiments/nfc_analysis").glob("*.py"))
    tracked += [ROOT / "scripts/experiment-data.cjs", ROOT / "src/platform/runtime.ts",
                ROOT / "src/bounded-contexts/experimentation/domain/dataset.ts",
                ROOT / "src/bounded-contexts/experimentation/domain/rules.ts",
                ROOT / "src/bounded-contexts/experimentation/domain/types.ts",
                ROOT / "tsconfig.json", ROOT / "package-lock.json",
                ROOT / "experiments/requirements.lock.txt"]
    write_json(folder / "manifest.json", {
        "schemaVersion": 1, "analysisVersion": VERSION, "python": platform.python_version(),
        "installedPackages": {name: importlib.metadata.version(name)
                              for name in ("matplotlib", "numpy") if not args.no_plots},
        "dataKind": run["dataKind"], "physicalEvidenceVerifiedByAnalysis": False,
        "inputFileSha256": hashlib.sha256(raw).hexdigest(), "datasetCanonicalSha256": bundle["checksum"],
        "analysisPlanSha256": digest(plan_path), "bootstrapRequested": args.bootstrap,
        "declaredVersions": {"api": run["apiVersion"], "mobile": run["mobileVersion"],
                             "protocol": run["protocolVersion"]},
        "sourceHashes": {str(p.relative_to(ROOT)).replace("\\", "/"): digest(p) for p in tracked},
        "artifacts": {p.name: digest(p) for p in sorted(folder.iterdir()) if p.is_file()},
    })
    print(f"Análise {report['status']}: {len(trials)} roteiros; artefatos em {folder}")


def plan(args):
    source = args.input.resolve(strict=True)
    config = json.loads(source.read_text(encoding="utf-8-sig"))
    assignments, rows = schedule(config)
    folder = args.output.resolve()
    folder.mkdir()
    shutil.copyfile(source, folder / "pilot-config.json")
    write_csv(folder / "assignments.csv", assignments)
    write_csv(folder / "attempt-plan.csv", rows)
    write_csv(folder / "observer-template.csv", [dict(taskId=r["taskId"], actualTrialId="", observedAt="",
                                                     observedTag="", observedBox="", legitimate="",
                                                     shouldAuthorize="", excluded="", exclusionReason="",
                                                     procedureNotes="") for r in rows])
    write_json(folder / "manifest.json", {
        "schemaVersion": 1, "status": "PLANEJAMENTO_PRELIMINAR_NAO_EXECUTADO",
        "protocolVersion": config["protocolVersion"], "seed": config["seed"],
        "python": platform.python_version(), "trialsPlanned": len(rows),
        "tags": len(config["tags"]), "devices": len(config["devices"]),
        "sessions": len(config["sessions"]), "physicalReadsPerformed": 0,
        "inputSha256": digest(source), "plannerSha256": digest(Path(__file__).with_name("planner.py")),
        "artifacts": {p.name: digest(p) for p in sorted(folder.iterdir()) if p.is_file()},
    })
    print(f"{len(rows)} tarefas planejadas; nenhuma leitura/registro na API realizado. Saída: {folder}")


def main():
    parser = argparse.ArgumentParser(description="Planejamento e análise offline NFC Trace; não coleta NFC.")
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("plan", "analyze"):
        command = commands.add_parser(name)
        command.add_argument("input", type=Path)
        command.add_argument("output", type=Path, help="Pasta nova, pai existente.")
        if name == "analyze":
            command.add_argument("--plan", type=Path, default=ROOT / "experiments/analysis-plan.json")
            command.add_argument("--bootstrap", action="store_true", help="Intervalo exploratório por etiqueta.")
            command.add_argument("--no-plots", action="store_true", help="Somente tabelas, para diagnóstico.")
        command.set_defaults(handler=plan if name == "plan" else analyze)
    args = parser.parse_args()
    try:
        args.handler(args)
    except (ValueError, OSError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print(f"Falha: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
