"""Generated semantic fixtures only. No row in these tests came from physical NFC."""

import copy
import csv
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from uuid import uuid4

from nfc_analysis.analysis import (
    contrasts, distribution, facts, reconciliation, summarize, timing_summary, uncertainty,
)
from nfc_analysis.cli import ROOT, validate_analysis_plan
from nfc_analysis.planner import schedule
from nfc_analysis.reporting import figures, write_csv


def uid():
    return str(uuid4())


def stored(value):
    return {"input": value, "userId": ACTOR, "recordedAt": "2026-10-07T10:00:00Z"}


ACTOR = uid()


def dataset():
    return {"schemaVersion": 1, "run": stored({
        "id": uid(), "name": "GENERATED SEMANTIC TEST; NO HARDWARE",
        "dataKind": "SINTETICO", "protocolVersion": "test.v1", "apiVersion": "test",
        "mobileVersion": "test", "configuration": {"tagModel": "NO HARDWARE", "antenna": "none",
        "position": "none", "surface": "none", "phoneCase": "none", "timeoutMs": 1000}}),
        "trials": [], "groundTruth": [], "clientRecords": [], "observations": [], "serverMeasurements": []}


def trial(d, treatment="UID", scenario="LEGITIMO_ONLINE", *, tag="TAG-1", device="PHONE-1",
          session=None, policy=None, truth=True, legitimate=True, should_authorize=True,
          excluded=False, status="AUTORIZADA", start=True, capture=True):
    tid, pid, oid, attempt, clock = [uid() for _ in range(5)]
    session = session or uid()
    t = {"id": tid, "runId": d["run"]["input"]["id"], "sessionId": session,
         "tagLabel": tag, "boxLabel": "BOX-1", "deviceId": device, "deviceModel": "generated",
         "osVersion": "fixture", "provisioningId": pid, "treatment": treatment, "policy": policy,
         "scenario": scenario, "mode": "SINTETICA", "ordinal": len(d["trials"]) + 1,
         "eventType": "MOVIMENTACAO"}
    d["trials"].append(stored(t))
    if truth:
        d["groundTruth"].append({**stored({
            "id": uid(), "trialId": tid, "legitimate": legitimate, "shouldAuthorize": should_authorize,
            "observedBox": "BOX-1", "observedTag": tag, "observedOrdinal": t["ordinal"],
            "observedAt": "2026-10-07T10:00:00Z", "source": "ROTEIRO_SINTETICO", "excluded": excluded,
            "exclusionReason": "CONFIGURACAO_DIVERGENTE" if excluded else "NAO_EXCLUIDA"}), "revision": 1})

    def record(stage, at, boundary="INSTANTE", duration=None, observation=None):
        r = {"id": uid(), "trialId": tid, "attemptId": attempt, "stage": stage,
             "observationId": observation, "deviceId": device, "occurredAt": "2026-10-07T10:00:00Z",
             "clockId": clock, "monotonicMs": at, "durationMs": duration, "boundary": boundary, "code": None}
        d["clientRecords"].append(stored(r))
        return r

    if start:
        record("TENTATIVA_INICIADA", 100)
    if capture:
        record("LEITURA_OK", 300, "SESSAO_NFC_ATE_EVIDENCIA", 200)
        record("CAPTURA_LOCAL", 320, observation=oid)
        record("CONFIRMACAO_LOCAL", 330, "INICIO_ATE_CONFIRMACAO_LOCAL", 230, oid)
        accepted = status == "AUTORIZADA"
        decision = {"accepted": accepted, "status": status, "reason": "FIXTURE"}
        d["observations"].append({"id": oid, "provisioningId": pid, "strategy": treatment,
                                  "receivedAt": "2026-10-07T10:00:00Z", "declaredAt": "2026-10-07T10:00:00Z",
                                  "deviceId": device, "userId": ACTOR, "eventType": "MOVIMENTACAO",
                                  "uid": "04AABBCCDDEE01", "ndef": None, "bytesBase64": None,
                                  "receipt": decision, "decisions": [{"revision": 1, "result": decision}],
                                  "movements": [{"id": uid(), "type": "MOVIMENTACAO"}] if accepted else [],
                                  "input": {"id": oid, "provisionamentoId": pid,
                                            "tipo": "MOVIMENTACAO", "dispositivoId": device}})
    return t, record


class AnalysisTest(unittest.TestCase):
    def test_synthetic_and_replay_never_count_as_physical_reads(self):
        d = dataset()
        t, _ = trial(d)
        self.assertEqual(facts(d)[0][0]["physicalReadAttempts"], 0)
        t["mode"] = "REEXECUCAO"
        self.assertEqual(facts(d)[0][0]["physicalReadAttempts"], 0)

    def test_physical_success_includes_failures_not_excluded_procedures(self):
        d = dataset()
        a, _ = trial(d)
        b, record = trial(d, capture=False)
        c, _ = trial(d, excluded=True)
        for t in (a, b, c):
            t["mode"] = "LEITURA_FISICA"  # Semantic unit fixture, not a physical corpus.
        record("LEITURA_FALHOU", 1100, "SESSAO_NFC_ATE_EVIDENCIA", 1000)
        group = summarize(facts(d)[0])[0]
        self.assertEqual(group["rates"]["readSuccess"], {"numerator": 1, "denominator": 2, "value": .5})
        self.assertEqual(group["readFailures"], 1)
        self.assertEqual(group["excluded"], 1)

    def test_scenarios_and_devices_remain_separate_no_global_attack_rate(self):
        d = dataset()
        trial(d, scenario="NDEF_COPIADO", legitimate=False, should_authorize=False)
        trial(d, scenario="BYTES_ALTERADOS", legitimate=False, should_authorize=False, status="REJEITADA")
        trial(d, scenario="NDEF_COPIADO", device="PHONE-2", legitimate=False, should_authorize=False)
        groups = summarize(facts(d)[0])
        self.assertEqual(len(groups), 3)
        self.assertEqual(sorted(g["rates"]["falseAcceptance"]["value"] for g in groups), [0, 1, 1])

    def test_latest_independent_truth_exclusion_is_used_older_rows_preserved(self):
        d = dataset()
        trial(d, legitimate=False, should_authorize=False)
        revision = copy.deepcopy(d["groundTruth"][0])
        revision["input"].update(id=uid(), excluded=True, exclusionReason="CONFIGURACAO_DIVERGENTE")
        revision["revision"] = 2
        d["groundTruth"].append(revision)
        row = facts(d)[0][0]
        self.assertEqual(row["truthRevision"], 2)
        self.assertEqual(row["falseAcceptDenominator"], 0)
        self.assertEqual(len(d["groundTruth"]), 2)

    def test_pending_is_separate_and_late_counts_as_definitive_legitimate_refusal(self):
        d = dataset()
        trial(d, status="PENDENTE")
        trial(d, status="TARDIA")
        trial(d, status="REJEITADA")
        group = summarize(facts(d)[0])[0]
        self.assertEqual(group["rates"]["falseRejection"]["value"], 2 / 3)
        self.assertEqual((group["pending"], group["late"], group["rejected"]), (1, 1, 1))
        self.assertTrue(group["provisional"])

    def test_missing_truth_cannot_become_correct_acceptance(self):
        d = dataset()
        trial(d, truth=False)
        group = summarize(facts(d)[0])[0]
        self.assertEqual(group["truthMissing"], 1)
        self.assertIsNone(group["rates"]["falseAcceptance"]["value"])
        self.assertIsNone(group["rates"]["falseRejection"]["value"])

    def test_local_confirmed_without_server_is_not_asserted_to_be_lost(self):
        d = dataset()
        trial(d)
        d["observations"].clear()
        row = facts(d)[0][0]
        self.assertEqual(row["confirmedLocalWithoutServer"], 1)
        self.assertEqual(row["storedLocal"], 0)
        self.assertNotIn("lost", row)
        self.assertTrue(summarize([row])[0]["provisional"])

    def test_same_uuid_retry_and_append_only_decisions_do_not_count_twice(self):
        d = dataset()
        trial(d, status="PENDENTE")
        d["observations"][0]["decisions"].append({"revision": 2, "result": {"accepted": True, "status": "AUTORIZADA"}})
        d["observations"][0]["movements"].append({"id": uid(), "type": "MOVIMENTACAO"})
        r = copy.deepcopy(d["clientRecords"][-1])
        r["input"].update(id=uid(), stage="ENVIO_CONFIRMADO", boundary="ENVIO_ATE_RESPOSTA")
        d["clientRecords"].append(r)
        row = facts(d)[0][0]
        self.assertEqual((row["storedCaptures"], row["authorized"], row["pending"]), (1, 1, 0))

    def test_authentication_reuse_and_authorization_are_separate(self):
        d = dataset()
        trial(d, "SDM", policy="ESTRITA", status="REJEITADA")
        d["observations"][0]["decisions"][0]["result"]["sdm"] = {"autenticada": True, "previamenteUtilizada": True}
        row = facts(d)[0][0]
        self.assertEqual((row["authenticated"], row["previouslyUsed"], row["authorized"]), (1, 1, 0))

    def test_clock_restart_and_impossible_declared_duration_are_censored(self):
        d = dataset()
        trial(d)
        d["clientRecords"][1]["input"]["clockId"] = uid()
        d["clientRecords"][3]["input"]["durationMs"] = 9999
        _, durations, issues = facts(d)
        self.assertEqual({d["censorReason"] for d in durations}, {"ORIGEM_AUSENTE_OU_REINICIADA", "DURACAO_MAIOR_QUE_INTERVALO", "MARCO_TERMINAL_AUSENTE"})
        self.assertEqual(len(issues), 2)
        self.assertTrue(all(d["ms"] is None for d in durations))

    def test_server_revisions_and_failure_stage_are_not_pooled_in_latency(self):
        d = dataset()
        trial(d)
        oid = d["observations"][0]["id"]
        for revision, ms in ((1, 10), (2, 30)):
            d["serverMeasurements"].append({"observationId": oid, "revision": revision,
                                             "boundary": "VALIDACAO_EVIDENCIA", "clockId": uid(), "startMs": 100, "endMs": 100 + ms})
        rows = [r for r in timing_summary(facts(d)[1]) if r["source"] == "SERVIDOR"]
        self.assertEqual([r["median"] for r in rows], [10, 30])

    def test_common_release_is_censored_if_any_treatment_not_complete(self):
        d = dataset()
        _, r1 = trial(d)
        _, r2 = trial(d, "SDM", policy="ESTRITA")
        clock = uid()
        a = r1("COMUNICACAO_LIBERADA", 1000)
        b = r2("COMUNICACAO_LIBERADA", 1000)
        for r in (a, b):
            r["clockId"] = clock
        oid = d["observations"][0]["id"]
        final = r1("RECONCILIACAO_CONCLUIDA", 1200, "LIBERACAO_ATE_DECISAO_FINAL", 200, oid)
        final["clockId"] = clock
        groups = reconciliation(d)
        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0]["eligible"], 2)
        self.assertIsNone(groups[0]["durationMs"])
        oid2 = d["observations"][1]["id"]
        f2 = r2("RECONCILIACAO_CONCLUIDA", 1400, "LIBERACAO_ATE_DECISAO_FINAL", 400, oid2)
        f2["clockId"] = clock
        self.assertEqual(reconciliation(d)[0]["durationMs"], 400)

    def test_quantiles_are_explicit_type_7_not_assumed_stable_p95(self):
        self.assertEqual(distribution([10, 20, 30, 40])["median"], 25)
        self.assertEqual(distribution([10, 20, 30, 40])["p95"], 38.5)
        self.assertIsNone(distribution([])["p95"])

    def test_paired_summary_weights_tags_equally_despite_unequal_taps_and_sessions(self):
        d = dataset()
        s = uid()
        for i in range(20):
            trial(d, "UID", session=s, tag="TAG-1", status="AUTORIZADA")
            trial(d, "NDEF_ESTATICO", session=s, tag="TAG-1", status="REJEITADA")
        trial(d, "UID", session=s, tag="TAG-2", status="REJEITADA")
        trial(d, "NDEF_ESTATICO", session=s, tag="TAG-2", status="AUTORIZADA")
        plan = json.loads((ROOT / "experiments/analysis-plan.json").read_text())
        plan["contrasts"] = [{"scenario": "LEGITIMO_ONLINE", "left": "UID", "right": "NDEF_ESTATICO", "metric": "falseRejection"}]
        results, blocks = contrasts(*facts(d)[:2], plan)
        self.assertEqual(results[0]["estimate"], 0)
        self.assertEqual(results[0]["pairedBlocks"], 2)
        self.assertEqual(sorted(b["difference"] for b in blocks), [-1, 1])

    def test_mismatched_device_or_session_is_not_paired(self):
        d = dataset()
        trial(d, "UID")
        trial(d, "NDEF_ESTATICO")
        plan = json.loads((ROOT / "experiments/analysis-plan.json").read_text())
        result, _ = contrasts(*facts(d)[:2], plan)
        self.assertEqual(result[3]["pairedBlocks"], 0)
        self.assertEqual(result[3]["unpairedBlocks"], 2)

    def test_bootstrap_is_reproducible_and_suppressed_for_few_or_constant_tags(self):
        settings = json.loads((ROOT / "experiments/analysis-plan.json").read_text())["bootstrap"]
        self.assertEqual(uncertainty({str(i): i for i in range(6)}, settings, True)["reason"], "POUCAS_ETIQUETAS")
        self.assertEqual(uncertainty({str(i): 0 for i in range(12)}, settings, True)["reason"], "SEM_VARIACAO_ENTRE_ETIQUETAS")
        values = {str(i): i / 12 for i in range(12)}
        a = uncertainty(values, settings, True)
        self.assertEqual(a, uncertainty(values, settings, True))
        self.assertLess(a["interval"][0], .46)
        self.assertGreater(a["interval"][1], .46)

    def test_plan_cannot_disable_the_preliminary_cluster_guard(self):
        plan = json.loads((ROOT / "experiments/analysis-plan.json").read_text())
        plan["bootstrap"]["minimumTags"] = 1
        with self.assertRaises(ValueError):
            validate_analysis_plan(plan)

    def test_pending_paired_contrast_suppresses_exploratory_interval(self):
        d = dataset()
        session = uid()
        trial(d, "UID", session=session, status="PENDENTE")
        trial(d, "NDEF_ESTATICO", session=session)
        plan = json.loads((ROOT / "experiments/analysis-plan.json").read_text())
        plan["contrasts"] = [{"scenario": "LEGITIMO_ONLINE", "left": "UID", "right": "NDEF_ESTATICO", "metric": "falseRejection"}]
        result, _ = contrasts(*facts(d)[:2], plan, bootstrap=True)
        self.assertTrue(result[0]["provisional"])
        self.assertEqual(result[0]["uncertainty"]["reason"], "BLOCOS_INCOMPLETOS_OU_PENDENCIAS")

    def test_missing_local_confirmation_marker_is_explicit_censor_not_zero(self):
        d = dataset()
        trial(d)
        d["clientRecords"].pop()
        _, durations, _ = facts(d)
        censored = [r for r in durations if r["boundary"] == "INICIO_ATE_CONFIRMACAO_LOCAL"]
        self.assertEqual(len(censored), 1)
        self.assertIsNone(censored[0]["ms"])
        self.assertEqual(censored[0]["censorReason"], "MARCO_TERMINAL_AUSENTE")

    def test_csv_formula_protection_does_not_change_numeric_differences(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "data.csv"
            write_csv(path, [{"label": "=malicious()", "difference": -2.5}])
            with path.open(encoding="utf-8-sig") as stream:
                row = next(csv.DictReader(stream))
            self.assertEqual(row, {"label": "'=malicious()", "difference": "-2.5"})


class PlannerTest(unittest.TestCase):
    def setUp(self):
        self.config = json.loads((ROOT / "experiments/pilot.example.json").read_text())

    def test_540_cells_order_balance_and_reproducibility(self):
        assignments, rows = schedule(self.config)
        self.assertEqual(len(rows), 540)
        self.assertEqual(len({a["order"] for a in assignments}), 6)
        self.assertEqual((assignments, rows), schedule(self.config))
        counts = {}
        for row in rows:
            key = (row["tagLabel"], row["deviceLabel"], row["treatment"])
            counts[key] = counts.get(key, 0) + 1
            self.assertNotIn("provisioningId", row)
        self.assertEqual(len(counts), 54)
        self.assertEqual(set(counts.values()), {10})
        self.config["seed"] = 425
        self.assertNotEqual(rows, schedule(self.config)[1])

    def test_two_phones_and_more_sessions_adjust_without_inventing_devices(self):
        self.config["devices"].pop()
        self.config["sessions"].append("PILOT-S2")
        self.assertEqual(len(schedule(self.config)[1]), 720)

    def test_invalid_inventory_or_unbalanced_tags_is_rejected(self):
        for field, value in (("tags", ["T1"]), ("devices", ["P1", "P1"]), ("sessions", []),
                             ("repetitions", True), ("timeoutMs", 0), ("eventType", "COLETA")):
            config = copy.deepcopy(self.config)
            config[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                schedule(config)


class CliTest(unittest.TestCase):
    def call(self, *args):
        return subprocess.run([sys.executable, "-m", "nfc_analysis.cli", *map(str, args)], cwd=ROOT,
                              env={**os.environ, "PYTHONPATH": str(ROOT / "experiments"),
                                   "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"},
                              capture_output=True, text=True, encoding="utf-8", timeout=120)

    def bundle(self, folder):
        d = dataset()
        trial(d)
        canonical = json.dumps(d, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        b = {"schemaVersion": 1, "dataset": d, "checksum": hashlib.sha256(canonical.encode()).hexdigest(),
             "summary": [{"authorized": 999999}], "integrity": {"status": "FAKE"}}
        path = folder / "input.json"
        path.write_text(json.dumps(b), encoding="utf-8")
        return path

    def test_cli_ignores_claimed_summary_recomputes_and_preserves_input(self):
        with tempfile.TemporaryDirectory() as name:
            folder = Path(name)
            source = self.bundle(folder)
            before = source.read_bytes()
            result = self.call("analyze", source, folder / "output", "--no-plots")
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads((folder / "output/analysis.json").read_text(encoding="utf8"))
            self.assertEqual(report["totals"]["authorized"], 1)
            self.assertEqual(report["status"], "CONTROLE_SINTETICO")
            self.assertEqual(source.read_bytes(), before)
            self.assertEqual((folder / "output/original-bundle.json").read_bytes(), before)
            self.assertNotEqual(self.call("analyze", source, folder / "output", "--no-plots").returncode, 0)
            self.assertEqual(source.read_bytes(), before)

    def test_tampered_checksum_and_duplicate_uuid_fail_before_output(self):
        with tempfile.TemporaryDirectory() as name:
            folder = Path(name)
            source = self.bundle(folder)
            b = json.loads(source.read_text())
            b["dataset"]["trials"][0]["input"]["tagLabel"] = "tampered"
            source.write_text(json.dumps(b))
            self.assertNotEqual(self.call("analyze", source, folder / "out", "--no-plots").returncode, 0)
            self.assertFalse((folder / "out").exists())
            source = self.bundle(folder)
            b = json.loads(source.read_text())
            b["dataset"]["trials"].append(copy.deepcopy(b["dataset"]["trials"][0]))
            canonical = json.dumps(b["dataset"], ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            b["checksum"] = hashlib.sha256(canonical.encode()).hexdigest()
            source.write_text(json.dumps(b))
            self.assertNotEqual(self.call("analyze", source, folder / "out", "--no-plots").returncode, 0)
            self.assertFalse((folder / "out").exists())

    def test_cli_plan_is_blank_observer_sheet_not_observed_results(self):
        with tempfile.TemporaryDirectory() as name:
            folder = Path(name) / "plan"
            result = self.call("plan", ROOT / "experiments/pilot.example.json", folder)
            self.assertEqual(result.returncode, 0, result.stderr)
            with (folder / "observer-template.csv").open(encoding="utf-8-sig") as stream:
                rows = list(csv.DictReader(stream))
            self.assertEqual(len(rows), 540)
            self.assertTrue(all(r["legitimate"] == r["observedAt"] == r["actualTrialId"] == "" for r in rows))

    def test_cli_figures_identify_synthetic_origin_and_manifest_verifies_artifacts(self):
        with tempfile.TemporaryDirectory() as name:
            folder = Path(name)
            source = self.bundle(folder)
            output = folder / "out"
            result = self.call("analyze", source, output)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("CONTROLE SINTÉTICO", (output / "rates-01.svg").read_text(encoding="utf8"))
            self.assertTrue((output / "rates-01.png").read_bytes().startswith(b"\x89PNG"))
            manifest = json.loads((output / "manifest.json").read_text(encoding="utf8"))
            self.assertFalse(manifest["physicalEvidenceVerifiedByAnalysis"])
            for artifact, expected in manifest["artifacts"].items():
                self.assertEqual(hashlib.sha256((output / artifact).read_bytes()).hexdigest(), expected)


if __name__ == "__main__":
    unittest.main()
