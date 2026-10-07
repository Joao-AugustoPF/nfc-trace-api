"""Recompute facts from raw rows, keeping scenario, mode and repeated units."""

from collections import defaultdict
import math
import random
import statistics

GROUP = ("dataKind", "mode", "scenario", "treatment", "policy", "deviceId")
COUNT_FIELDS = (
    "planned", "unstarted", "readAttempts", "readSuccess", "readFailures",
    "readInterrupted", "readUnfinished", "physicalReadAttempts", "physicalReadSuccess",
    "localCaptures", "confirmedLocal", "storedCaptures", "storedLocal",
    "localWithoutServer", "confirmedLocalWithoutServer", "authorized", "rejected",
    "pending", "late", "authenticated", "previouslyUsed", "duplicateEffects",
    "truthMissing", "excluded", "falseAccepts", "falseAcceptDenominator",
    "falseRejects", "falseRejectDenominator", "lateLegitimate",
)
RATE_FIELDS = {
    "readSuccess": ("physicalReadSuccess", "physicalReadAttempts"),
    "preservation": ("storedLocal", "localCaptures"),
    "falseAcceptance": ("falseAccepts", "falseAcceptDenominator"),
    "falseRejection": ("falseRejects", "falseRejectDenominator"),
}
ORIGINS = {
    "SESSAO_NFC_ATE_EVIDENCIA": "TENTATIVA_INICIADA",
    "INICIO_ATE_CONFIRMACAO_LOCAL": "TENTATIVA_INICIADA",
    "INICIO_ATE_DECISAO_FINAL": "TENTATIVA_INICIADA",
    "LIBERACAO_ATE_DECISAO_FINAL": "COMUNICACAO_LIBERADA",
    "ENVIO_ATE_RESPOSTA": "ENVIO_INICIADO",
}


def quantile(values, probability):
    """Linear interpolation between order statistics (type 7)."""
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * probability
    low, high = math.floor(position), math.ceil(position)
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def distribution(values):
    return {
        "n": len(values), "median": quantile(values, .5),
        "q1": quantile(values, .25), "q3": quantile(values, .75),
        "p95": quantile(values, .95),
        "min": min(values) if values else None, "max": max(values) if values else None,
    }


def rate(numerator, denominator):
    return {"numerator": numerator, "denominator": denominator,
            "value": numerator / denominator if denominator else None}


def _client_duration(record, records):
    duration = record["durationMs"]
    if duration is None:
        return None, "DURACAO_AUSENTE"
    candidates = [r for r in records if r["attemptId"] == record["attemptId"]
                  and r["stage"] == ORIGINS[record["boundary"]]
                  and r["clockId"] == record["clockId"]
                  and r["monotonicMs"] <= record["monotonicMs"]]
    # A network retry uses the latest preceding start in the same clock.
    if not candidates:
        return None, "ORIGEM_AUSENTE_OU_REINICIADA"
    start = max(candidates, key=lambda r: r["monotonicMs"])
    expected = record["monotonicMs"] - start["monotonicMs"]
    # Markers are persisted after the measured operation. The declared duration can
    # be smaller than the marker interval, but never larger (allow 1ms rounding).
    if duration > expected + 1:
        return None, "DURACAO_MAIOR_QUE_INTERVALO"
    return duration, None


def facts(dataset):
    truths = {}
    records_by_trial = defaultdict(list)
    observations = {o["id"]: o for o in dataset["observations"]}
    measures = defaultdict(list)
    for row in dataset["groundTruth"]:
        trial = row["input"]["trialId"]
        if trial not in truths or row["revision"] > truths[trial]["revision"]:
            truths[trial] = row
    for row in dataset["clientRecords"]:
        records_by_trial[row["input"]["trialId"]].append(row["input"])
    for row in dataset["serverMeasurements"]:
        measures[row["observationId"]].append(row)
    result, durations, issues = [], [], []
    for trial in dataset["trials"]:
        t = trial["input"]
        records = records_by_trial[t["id"]]
        identity = {"runId": dataset["run"]["input"]["id"],
                    "dataKind": dataset["run"]["input"]["dataKind"],
                    **{key: t[key] for key in GROUP if key != "dataKind"},
                    "trialId": t["id"], "tagLabel": t["tagLabel"],
                    "sessionId": t["sessionId"], "provisioningId": t["provisioningId"]}
        row = {**identity, **dict.fromkeys(COUNT_FIELDS, 0)}
        truth_record = truths.get(t["id"])
        truth = truth_record["input"] if truth_record else None
        row.update(truthRevision=truth_record["revision"] if truth_record else None,
                   exclusionReason=truth["exclusionReason"] if truth else None,
                   legitimate=truth["legitimate"] if truth else None,
                   shouldAuthorize=truth["shouldAuthorize"] if truth else None,
                   planned=1, truthMissing=int(truth is None),
                   excluded=int(bool(truth and truth["excluded"])))
        for stage, field in (("TENTATIVA_INICIADA", "readAttempts"),
                             ("LEITURA_OK", "readSuccess"),
                             ("LEITURA_FALHOU", "readFailures"),
                             ("LEITURA_INTERROMPIDA", "readInterrupted")):
            row[field] = sum(r["stage"] == stage for r in records)
        row["unstarted"] = int(not row["readAttempts"])
        row["readUnfinished"] = row["readAttempts"] - sum(
            row[f] for f in ("readSuccess", "readFailures", "readInterrupted"))
        if t["mode"] == "LEITURA_FISICA":
            row["physicalReadAttempts"] = row["readAttempts"]
            row["physicalReadSuccess"] = row["readSuccess"]
        # Physical failures count in reading success even if the procedure was
        # interrupted. Explicit protocol exclusions affect the eligible estimates.
        if row["excluded"]:
            row["physicalReadAttempts"] = row["physicalReadSuccess"] = 0
        ids = {r["observationId"] for r in records if r["observationId"]}
        local = {r["observationId"] for r in records if r["stage"] == "CAPTURA_LOCAL"}
        confirmed = {r["observationId"] for r in records if r["stage"] == "CONFIRMACAO_LOCAL"}
        stored = ids & observations.keys()
        row.update(localCaptures=len(local), confirmedLocal=len(confirmed),
                   storedCaptures=len(stored), storedLocal=len(local & stored),
                   localWithoutServer=len(local - stored),
                   confirmedLocalWithoutServer=len(confirmed - stored))
        outcomes = []
        for oid in sorted(stored):
            observation = observations[oid]
            decision = max(observation["decisions"], key=lambda d: d["revision"])["result"]
            outcomes.append(decision)
            row["duplicateEffects"] += max(0, len(observation["movements"]) - 1)
            for measure in measures[oid]:
                durations.append({**identity, "source": "SERVIDOR", "boundary": measure["boundary"],
                                  "stage": "REVISAO_DECISAO", "revision": measure["revision"],
                                  "observationId": oid, "clockId": measure["clockId"],
                                  "ms": measure["endMs"] - measure["startMs"], "censorReason": None,
                                  "excluded": row["excluded"]})
        for decision in outcomes:
            row["authorized"] += int(decision["accepted"])
            for status, field in (("REJEITADA", "rejected"), ("PENDENTE", "pending"), ("TARDIA", "late")):
                row[field] += int(decision["status"] == status)
            sdm = decision.get("sdm") or {}
            row["authenticated"] += int(sdm.get("autenticada") is True)
            row["previouslyUsed"] += int(sdm.get("previamenteUtilizada") is True)
        if truth and not truth["excluded"]:
            if not truth["legitimate"] and not truth["shouldAuthorize"]:
                row.update(falseAccepts=row["authorized"], falseAcceptDenominator=len(stored))
            if truth["legitimate"] and truth["shouldAuthorize"]:
                row.update(falseRejects=row["rejected"] + row["late"], falseRejectDenominator=len(stored))
            if truth["legitimate"]:
                row["lateLegitimate"] = row["late"]
        for record in records:
            if record["boundary"] not in ORIGINS:
                continue
            ms, reason = _client_duration(record, records)
            durations.append({**identity, "source": "MOBILE_DECLARADO", "boundary": record["boundary"],
                              "stage": record["stage"], "revision": None,
                              "observationId": record["observationId"], "clockId": record["clockId"],
                              "ms": ms, "censorReason": reason, "excluded": row["excluded"]})
            if reason and reason != "DURACAO_AUSENTE":
                issues.append({"trialId": t["id"], "recordId": record["id"], "reason": reason})
        for start in [r for r in records if r["stage"] == "TENTATIVA_INICIADA"]:
            attempt_records = [r for r in records if r["attemptId"] == start["attemptId"]]
            expected = [("SESSAO_NFC_ATE_EVIDENCIA", "LEITURA_SEM_MEDIDA")]
            if any(r["stage"] == "CAPTURA_LOCAL" for r in attempt_records):
                expected += [("INICIO_ATE_CONFIRMACAO_LOCAL", "CONFIRMACAO_LOCAL"),
                             ("INICIO_ATE_DECISAO_FINAL", "CONFIRMACAO_FINAL")]
            for boundary, stage in expected:
                if not any(r["boundary"] == boundary for r in attempt_records):
                    durations.append({**identity, "source": "MOBILE_DECLARADO", "boundary": boundary,
                                      "stage": stage, "revision": None, "observationId": None,
                                      "clockId": start["clockId"], "ms": None,
                                      "censorReason": "MARCO_TERMINAL_AUSENTE",
                                      "excluded": row["excluded"]})
        result.append(row)
    return result, durations, issues


def _group(rows, fields):
    groups = defaultdict(list)
    for row in rows:
        groups[tuple(row[field] for field in fields)].append(row)
    return groups


def summarize(rows):
    output = []
    for key, members in _group(rows, GROUP).items():
        counts = {field: sum(row[field] for row in members) for field in COUNT_FIELDS}
        output.append({**dict(zip(GROUP, key)), **counts,
                       "tags": len({r["tagLabel"] for r in members}),
                       "sessions": len({r["sessionId"] for r in members}),
                       "provisional": bool(counts["truthMissing"] or counts["unstarted"] or
                                           counts["pending"] or counts["readUnfinished"] or
                                           counts["localWithoutServer"]),
                       "rates": {name: rate(counts[num], counts[den])
                                 for name, (num, den) in RATE_FIELDS.items()}})
    return output


def timing_summary(durations):
    output = []
    fields = (*GROUP, "source", "boundary", "stage", "revision")
    for key, rows in _group(durations, fields).items():
        eligible = [r for r in rows if not r["excluded"]]
        values = [r["ms"] for r in eligible if r["ms"] is not None]
        output.append({**dict(zip(fields, key)), **distribution(values), "unit": "ms",
                       "censored": sum(r["ms"] is None for r in eligible),
                       "excluded": sum(r["excluded"] for r in rows),
                       "tags": len({r["tagLabel"] for r in eligible}),
                       "p95Unstable": len(values) < 20})
    return output


def uncertainty(values_by_tag, settings, enabled):
    values = list(values_by_tag.values())
    reason = ("DESATIVADO" if not enabled else
              "POUCAS_ETIQUETAS" if len(values) < settings["minimumTags"] else
              "SEM_VARIACAO_ENTRE_ETIQUETAS" if len(set(values)) < 2 else None)
    if reason:
        return {"interval": None, "reason": reason, "tags": len(values)}
    rng = random.Random(settings["seed"])
    replicates = [statistics.mean(rng.choices(values, k=len(values)))
                  for _ in range(settings["replicates"])]
    return {"interval": [quantile(replicates, p) for p in settings["interval"]],
            "reason": None, "tags": len(values), "replicates": settings["replicates"],
            "interpretation": settings["interpretation"],
            "method": "PERCENTIS_BOOTSTRAP_ETIQUETA_MEDIA_DOS_CONTRASTES_PAREADOS"}


def contrasts(rows, durations, plan, bootstrap=False):
    """Pair cell summaries, average paired differences per tag, then weight tags equally.

    Cells keep device/session/scenario/mode together. Sessions and both treatments
    stay together when a tag is resampled. No independent-tap tests or p-values.
    """
    results, blocks = [], []
    for specification in plan["contrasts"]:
        metric = specification["metric"]
        is_rate = metric in RATE_FIELDS
        source = rows if is_rate else [d for d in durations
                                       if d["boundary"] == metric and d["source"] == "MOBILE_DECLARADO"
                                       and d["ms"] is not None]
        for mode in sorted({r["mode"] for r in rows}):
            cells = defaultdict(list)
            for row in source:
                if row["excluded"] or row["mode"] != mode or row["scenario"] != specification["scenario"]:
                    continue
                condition = row["treatment"] + (":" + row["policy"] if row["policy"] else "")
                cell = (row["tagLabel"], row["deviceId"], row["sessionId"])
                cells[(cell, condition)].append(row)
            all_cells = {cell for cell, condition in cells
                         if condition in (specification["left"], specification["right"])}
            per_tag = defaultdict(list)
            incomplete = 0
            for cell in sorted(all_cells):
                values = []
                for condition in (specification["left"], specification["right"]):
                    data = cells.get((cell, condition), [])
                    if is_rate:
                        num, den = RATE_FIELDS[metric]
                        values.append(rate(sum(r[num] for r in data), sum(r[den] for r in data))["value"])
                    else:
                        values.append(quantile([r["ms"] for r in data], .5))
                if any(value is None for value in values):
                    incomplete += 1
                    continue
                difference = values[1] - values[0]
                per_tag[cell[0]].append(difference)
                blocks.append({**specification, "mode": mode, "tagLabel": cell[0],
                               "deviceId": cell[1], "sessionId": cell[2],
                               "leftValue": values[0], "rightValue": values[1],
                               "difference": difference})
            tag_values = {tag: statistics.mean(v) for tag, v in sorted(per_tag.items())}
            scope = [r for r in rows if r["mode"] == mode and r["scenario"] == specification["scenario"]
                     and not r["excluded"] and (r["treatment"] + (":" + r["policy"] if r["policy"] else ""))
                     in (specification["left"], specification["right"])]
            provisional = bool(incomplete or any(r["unstarted"] or r["pending"] or r["truthMissing"]
                                                or r["readUnfinished"] or r["localWithoutServer"] for r in scope))
            scope_ids = {r["trialId"] for r in scope}
            censored_measurements = (0 if is_rate else sum(d["trialId"] in scope_ids and
                                     d["boundary"] == metric and d["ms"] is None for d in durations))
            provisional = provisional or bool(censored_measurements)
            interval = uncertainty(tag_values, plan["bootstrap"], bootstrap and not provisional)
            if bootstrap and provisional:
                interval["reason"] = "BLOCOS_INCOMPLETOS_OU_PENDENCIAS"
            results.append({**specification, "mode": mode, "unit": "proporcao" if is_rate else "ms",
                            "estimand": "MEDIA_ETIQUETAS_DIFERENCA_DIREITA_MENOS_ESQUERDA",
                            "pairedBlocks": sum(len(v) for v in per_tag.values()),
                            "censoredMeasurements": censored_measurements,
                            "unpairedBlocks": incomplete, "tags": len(tag_values),
                            "estimate": statistics.mean(tag_values.values()) if tag_values else None,
                            "tagDistribution": distribution(list(tag_values.values())),
                            "provisional": provisional, "uncertainty": interval,
                            "comparability": "EXIGE_CONTROLES_E_EPOCAS_DO_PROTOCOLO"})
    return results, blocks


def reconciliation(dataset):
    """One duration per common release, across ALL treatments in that release."""
    records = [r["input"] for r in dataset["clientRecords"]]
    trials = {r["input"]["id"]: r["input"] for r in dataset["trials"]}
    groups = defaultdict(list)
    for r in records:
        if r["stage"] == "COMUNICACAO_LIBERADA":
            groups[(r["deviceId"], r["clockId"], r["monotonicMs"])].append(r)
    output = []
    for (device, clock, start), releases in groups.items():
        durations = []
        for release in releases:
            final = [r for r in records if r["attemptId"] == release["attemptId"]
                     and r["stage"] == "RECONCILIACAO_CONCLUIDA"]
            if len(final) != 1:
                durations.append(None)
            else:
                durations.append(_client_duration(final[0], records)[0])
        complete = all(v is not None for v in durations)
        output.append({"deviceId": device, "clockId": clock, "startMs": start,
                       "eligible": len(releases), "finals": sum(v is not None for v in durations),
                       "durationMs": max(durations) if complete else None,
                       "complete": complete, "trialIds": [r["trialId"] for r in releases],
                       "conditions": sorted({trials[r["trialId"]]["treatment"] + ":" +
                                             str(trials[r["trialId"]]["policy"]) for r in releases})})
    return output
