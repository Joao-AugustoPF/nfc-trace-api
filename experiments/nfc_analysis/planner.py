"""Generate a schedule, never physical evidence or API provisioning identities."""

import itertools
import random

TREATMENTS = ("UID", "NDEF_ESTATICO", "SDM")


def schedule(config):
    if config.get("schemaVersion") != 1 or config.get("status") != "PRELIMINAR":
        raise ValueError("Planejamento exige schemaVersion=1 e status PRELIMINAR.")
    for field in ("tags", "devices", "sessions"):
        values = config.get(field)
        if not isinstance(values, list) or not values or any(
            not isinstance(v, str) or not v.strip() for v in values
        ) or len(set(values)) != len(values):
            raise ValueError(f"Lista de {field} vazia, inválida ou duplicada.")
    if len(config["tags"]) % 6:
        raise ValueError("O crossover balanceado exige múltiplos de seis etiquetas.")
    for field in ("repetitions", "timeoutMs"):
        value = config.get(field)
        if type(value) is not int or value < 1:
            raise ValueError(f"{field} precisa ser inteiro positivo.")
    if type(config.get("seed")) is not int or not config.get("protocolVersion"):
        raise ValueError("Informe seed inteiro e versão do protocolo.")
    if config.get("eventType") != "MOVIMENTACAO" or config.get("sdmPolicy") not in (
        "ESTRITA", "REGISTRO_TARDIO"
    ):
        raise ValueError("Piloto A usa MOVIMENTACAO e uma política SDM explícita.")
    if not isinstance(config.get("configuration"), dict):
        raise ValueError("Informe os controles físicos, ainda que preliminares.")
    rng = random.Random(config["seed"])
    orders = list(itertools.permutations(TREATMENTS)) * (len(config["tags"]) // 6)
    rng.shuffle(orders)
    assignments = [dict(tagLabel=tag, order=" > ".join(order))
                   for tag, order in zip(config["tags"], orders)]
    rows = []
    # Preserve each tag's crossover order; shuffle tag/device/repetition within period.
    for session in config["sessions"]:
        for period in range(3):
            blocks = list(itertools.product(range(len(orders)), config["devices"]))
            rng.shuffle(blocks)
            for index, device in blocks:
                repetitions = list(range(1, config["repetitions"] + 1))
                rng.shuffle(repetitions)
                for repetition in repetitions:
                    treatment = orders[index][period]
                    rows.append({
                        "taskId": f"PLAN-{len(rows) + 1:06d}",
                        "sessionLabel": session,
                        "tagLabel": config["tags"][index],
                        "deviceLabel": device,
                        "period": period + 1,
                        "repetition": repetition,
                        "treatment": treatment,
                        "policy": config["sdmPolicy"] if treatment == "SDM" else "",
                        "scenario": "LEGITIMO_ONLINE",
                        "eventType": config["eventType"],
                        "timeoutMs": config["timeoutMs"],
                    })
    return assignments, rows
