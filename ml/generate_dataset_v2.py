"""
Generador de dataset sintetico V2 — Control Tower / prediccion preventiva.

Diferencia clave con V1: las metricas NO se inventan directamente. Se simula
una mezcla de (transaction status, response_code) coherente con la tabla
publicada por Yuno, y las features se DERIVAN de esa mezcla, igual que el
runtime las deriva de PostgreSQL.

Fuente de los codigos y statuses:
https://docs.y.uno/reference/payments/status-and-response-codes/transaction

Target: will_degrade_within_15m
  1  -> la degradacion REAL empieza dentro de los proximos 15 minutos
  0  -> no
Las filas posteriores al inicio de la degradacion se descartan: el predictor
es preventivo, no reactivo.
"""

import csv
import math
import random
from datetime import datetime, timedelta, timezone
from pathlib import Path

from local_time import DEMO_COUNTRY_TIME_ZONES, daypart_of, encode_local_time

STEPS_PER_EPISODE = 18
STEP_MINUTES = 5
MINUTES_IN_DAY = 1440
PREDICTION_HORIZON_MINUTES = 15
PREDICTION_STEPS = PREDICTION_HORIZON_MINUTES // STEP_MINUTES  # 3
EPISODES = 3200
RANDOM_SEED = 42

OUTPUT = Path(__file__).parent / "data" / "training_v2.csv"

rng = random.Random(RANDOM_SEED)

# Rutas sinteticas con su zona IANA. El pais NO determina la zona de forma
# univoca (MX y BR tienen varias); esto vale porque controlamos la geografia
# de la demo, no como regla general.
ROUTES = [
    ("CO", DEMO_COUNTRY_TIME_ZONES["CO"]),
    ("MX", DEMO_COUNTRY_TIME_ZONES["MX"]),
    ("BR", DEMO_COUNTRY_TIME_ZONES["BR"]),
    ("PE", DEMO_COUNTRY_TIME_ZONES["PE"]),
    ("ES", DEMO_COUNTRY_TIME_ZONES["ES"]),
]

# ---------------------------------------------------------------------------
# Perfil diurno SINTETICO.
#
# ESTO ES UN SUPUESTO DE SIMULACION, NO UN DATO DE YUNO. La documentacion
# publica no describe curvas de aprobacion nocturnas. Se modela:
#   - volumen bajo de madrugada y pico de tarde,
#   - aprobacion levemente menor de noche (mas trafico recurrente/reintentos),
#   - latencia levemente mayor de madrugada (ventanas de mantenimiento).
# El objetivo es que "noche sana" exista en el dataset con target = 0.
# ---------------------------------------------------------------------------

def diurnal_volume(local_hour: int) -> float:
    """Multiplicador de volumen: ~0.25 de madrugada, ~1.0 en el pico."""
    return 0.25 + 0.75 * (math.sin(math.pi * ((local_hour - 4) % 24) / 24) ** 2)


def diurnal_approval_shift(local_hour: int) -> float:
    """Desplazamiento de aprobacion por hora local. Supuesto, no dato de Yuno."""
    return -0.030 if local_hour < 6 else (-0.010 if local_hour >= 22 else 0.0)


def diurnal_latency_shift(local_hour: int) -> float:
    return 90.0 if local_hour < 6 else 0.0

# ---------------------------------------------------------------------------
# Dominios logicos (inferencia nuestra) por response_code.
# Debe coincidir con src/common/yuno-taxonomy.ts
# ---------------------------------------------------------------------------

CODES = {
    # code: (yuno_status, failure_domain, decline_type)
    "SUCCEEDED":                    ("SUCCEEDED", None, "N_A"),
    "INSUFFICIENT_FUNDS":           ("DECLINED", "ISSUER", "SOFT"),
    "DO_NOT_HONOR":                 ("DECLINED", "ISSUER", "SOFT"),
    "DECLINED_BY_BANK":             ("DECLINED", "ISSUER", "SOFT"),
    "RESTRICTED_BY_BANK":           ("DECLINED", "ISSUER", "SOFT"),
    "REFER_TO_CARD_ISSUER":         ("DECLINED", "ISSUER", "SOFT"),
    "REPORTED_STOLEN":              ("DECLINED", "ISSUER", "HARD"),
    "EXPIRED_CARD":                 ("DECLINED", "MERCHANT_DATA", "HARD"),
    "INVALID_SECURITY_CODE":        ("DECLINED", "MERCHANT_DATA", "HARD"),
    "INVALID_CARD_NUMBER":          ("DECLINED", "MERCHANT_DATA", "HARD"),
    "BAD_FILLED_INFO":              ("DECLINED", "MERCHANT_DATA", "HARD"),
    "FRAUD_VALIDATION":             ("DECLINED", "FRAUD_SCREENING", "SOFT"),
    "FRAUD_VERIFICATION_DECLINED":  ("DECLINED", "FRAUD_SCREENING", "UNKNOWN"),
    "AUTHENTICATION_FAILED_THREE_D_SECURE": ("DECLINED", "AUTHENTICATION_3DS", "N_A"),
    "REJECTED_THREE_D_SECURE_REQUIRED":     ("DECLINED", "AUTHENTICATION_3DS", "SOFT"),
    "THREE_D_SECURE_REQUIRED":      ("DECLINED", "AUTHENTICATION_3DS", "SOFT"),
    "ACQUIRE_CONTINGENCY":          ("DECLINED", "PROVIDER", "SOFT"),
    "REQUESTS_EXCEEDED":            ("DECLINED", "PROVIDER", "SOFT"),
    "DECLINED_BY_PROVIDER":         ("DECLINED", "PROVIDER", "SOFT"),
    "TERMINAL_ERROR":               ("DECLINED", "PROVIDER_CONFIGURATION", "SOFT"),
    "INVALID_CREDENTIALS":          ("DECLINED", "PROVIDER_CONFIGURATION", "HARD"),
    "PROVIDER_TIMEOUT":             ("ERROR", "PROVIDER", "SOFT"),
    "PROVIDER_ERROR":               ("ERROR", "PROVIDER", "SOFT"),
    "PROVIDER_INTERNAL_ERROR":      ("ERROR", "PROVIDER", "SOFT"),
    "PROVIDER_INVALID_CREDENTIALS": ("ERROR", "PROVIDER_CONFIGURATION", "HARD"),
    "PROVIDER_INVALID_API_VERSION": ("ERROR", "PROVIDER_CONFIGURATION", "HARD"),
    "INVALID_PARAMETERS":           ("REJECTED", "PRE_PROVIDER", "HARD"),
    "MISSING_PARAMETERS":           ("REJECTED", "PRE_PROVIDER", "HARD"),
    "INVALID_REQUEST":              ("REJECTED", "PRE_PROVIDER", "HARD"),
    "CURRENCY_NOT_ALLOWED":         ("REJECTED", "PRE_PROVIDER", "HARD"),
}

HEALTHY = {
    "SUCCEEDED": 0.910,
    "INSUFFICIENT_FUNDS": 0.026,
    "DO_NOT_HONOR": 0.018,
    "DECLINED_BY_BANK": 0.008,
    "EXPIRED_CARD": 0.008,
    "INVALID_SECURITY_CODE": 0.006,
    "FRAUD_VALIDATION": 0.006,
    "AUTHENTICATION_FAILED_THREE_D_SECURE": 0.005,
    "PROVIDER_TIMEOUT": 0.004,
    "PROVIDER_ERROR": 0.005,
    "INVALID_PARAMETERS": 0.004,
}

# Escenarios: (peso, codigos que crecen, intensidad, lead de latencia en pasos,
#              ruido de precursor). `lead` > 0 = hay senal precursora.
SCENARIOS = {
    "NORMAL":                          dict(w=22, codes={}, sev=0.00, lead=0, latency=0.0),
    "RECOVERY":                        dict(w=8,  codes={}, sev=0.00, lead=0, latency=0.0),
    "SUDDEN_FAILURE":                  dict(w=8,  codes={"PROVIDER_ERROR": 0.5, "PROVIDER_TIMEOUT": 0.3}, sev=0.55, lead=0, latency=0.3),
    "PROVIDER_LATENCY_DEGRADATION":    dict(w=10, codes={"PROVIDER_TIMEOUT": 0.6, "ACQUIRE_CONTINGENCY": 0.2}, sev=0.35, lead=3, latency=1.0),
    "PROVIDER_TIMEOUT_DEGRADATION":    dict(w=10, codes={"PROVIDER_TIMEOUT": 0.8}, sev=0.45, lead=3, latency=0.9),
    "PROVIDER_RATE_LIMIT":             dict(w=7,  codes={"REQUESTS_EXCEEDED": 0.7, "ACQUIRE_CONTINGENCY": 0.2}, sev=0.40, lead=2, latency=0.4),
    "PROVIDER_CONFIGURATION_FAILURE":  dict(w=7,  codes={"PROVIDER_INVALID_CREDENTIALS": 0.6, "INVALID_CREDENTIALS": 0.3}, sev=0.70, lead=0, latency=0.0),
    "PRE_PROVIDER_REJECTION_SURGE":    dict(w=7,  codes={"INVALID_PARAMETERS": 0.5, "MISSING_PARAMETERS": 0.3, "INVALID_REQUEST": 0.2}, sev=0.45, lead=1, latency=0.0),
    "ISSUER_DECLINE_SURGE":            dict(w=9,  codes={"DO_NOT_HONOR": 0.4, "INSUFFICIENT_FUNDS": 0.3, "RESTRICTED_BY_BANK": 0.2}, sev=0.30, lead=2, latency=0.0),
    "AUTHENTICATION_3DS_DEGRADATION":  dict(w=7,  codes={"AUTHENTICATION_FAILED_THREE_D_SECURE": 0.6, "REJECTED_THREE_D_SECURE_REQUIRED": 0.3}, sev=0.35, lead=2, latency=0.2),
    "FRAUD_SCREENING_DEGRADATION":     dict(w=6,  codes={"FRAUD_VALIDATION": 0.7, "FRAUD_VERIFICATION_DECLINED": 0.2}, sev=0.30, lead=1, latency=0.1),
    "MERCHANT_DATA_QUALITY_DEGRADATION": dict(w=6, codes={"BAD_FILLED_INFO": 0.4, "INVALID_SECURITY_CODE": 0.3, "INVALID_CARD_NUMBER": 0.2}, sev=0.25, lead=1, latency=0.0),
    "ROUTING_FALLBACK_STRESS":         dict(w=6,  codes={"DECLINED_BY_PROVIDER": 0.4, "PROVIDER_ERROR": 0.3, "ACQUIRE_CONTINGENCY": 0.2}, sev=0.30, lead=2, latency=0.5),
}

NAMES = list(SCENARIOS)
WEIGHTS = [SCENARIOS[n]["w"] for n in NAMES]

# La degradacion se considera REAL cuando la conversion cae por debajo de este
# margen respecto al baseline del segmento.
DEGRADATION_DROP = 0.12


def clip(v, lo, hi):
    return max(lo, min(hi, v))


def mix_for_step(cfg, intensity):
    """Mezcla de response codes en un paso, dada la intensidad de la degradacion."""
    mix = dict(HEALTHY)
    if intensity <= 0 or not cfg["codes"]:
        return mix
    # el exceso se resta de SUCCEEDED
    total_extra = cfg["sev"] * intensity
    for code, share in cfg["codes"].items():
        mix[code] = mix.get(code, 0.0) + total_extra * share
    mix["SUCCEEDED"] = max(0.02, mix["SUCCEEDED"] - total_extra)
    return mix


def sample_counts(mix, attempts, rnd):
    """Multinomial simple sobre la mezcla."""
    codes = list(mix)
    weights = [max(0.0, mix[c]) for c in codes]
    total = sum(weights)
    weights = [w / total for w in weights]
    counts = {c: 0 for c in codes}
    for _ in range(attempts):
        r = rnd.random()
        acc = 0.0
        for c, w in zip(codes, weights):
            acc += w
            if r <= acc:
                counts[c] += 1
                break
        else:
            counts[codes[-1]] += 1
    return counts


def derive(counts, attempts):
    """Deriva las metricas observables. Debe espejar el runtime en TypeScript."""
    approved = counts.get("SUCCEEDED", 0)
    dom = {"ISSUER": 0, "PROVIDER": 0, "PROVIDER_CONFIGURATION": 0, "PRE_PROVIDER": 0,
           "AUTHENTICATION_3DS": 0, "FRAUD_SCREENING": 0, "MERCHANT_DATA": 0}
    hard = soft = failures = 0
    timeouts = errors = rejected = 0
    for code, n in counts.items():
        if n == 0 or code == "SUCCEEDED":
            continue
        status, domain, decline = CODES[code]
        failures += n
        if domain in dom:
            dom[domain] += n
        if decline == "HARD":
            hard += n
        elif decline == "SOFT":
            soft += n
        if status == "ERROR":
            errors += n
            if code == "PROVIDER_TIMEOUT":
                timeouts += n
        elif status == "REJECTED":
            rejected += n
    r = lambda x: x / attempts if attempts else 0.0
    return {
        "approval_rate": r(approved),
        "provider_error_rate": r(errors),
        "provider_timeout_rate": r(timeouts),
        "rejected_rate": r(rejected),
        "issuer_decline_rate": r(dom["ISSUER"]),
        "auth_3ds_failure_rate": r(dom["AUTHENTICATION_3DS"]),
        "fraud_screening_failure_rate": r(dom["FRAUD_SCREENING"]),
        "data_quality_failure_rate": r(dom["MERCHANT_DATA"]),
        "provider_config_failure_rate": r(dom["PROVIDER_CONFIGURATION"]),
        "hard_decline_share": (hard / failures) if failures else 0.0,
    }


def generate_episode(episode_id):
    name = rng.choices(NAMES, weights=WEIGHTS, k=1)[0]
    cfg = SCENARIOS[name]
    baseline = clip(rng.gauss(0.91, 0.025), 0.80, 0.97)
    base_latency = rng.gauss(600, 90)

    # Ancla temporal ALEATORIA sobre las 24 h y sobre varios dias, y ruta
    # aleatoria. Sin esto, el escenario quedaria correlacionado con la hora y
    # el modelo aprenderia "las 14:00 son fallo".
    country, tz_name = rng.choice(ROUTES)
    anchor = datetime(2026, 3, 2, tzinfo=timezone.utc) + timedelta(
        days=rng.randint(0, 27),
        minutes=rng.randrange(0, MINUTES_IN_DAY, STEP_MINUTES),
    )

    degrades = cfg["sev"] > 0
    onset = rng.randint(6, STEPS_PER_EPISODE - 3) if degrades else None

    # RECOVERY: empieza degradado y mejora. Sirve de falsa alarma: hay senal
    # negativa pero la degradacion futura no ocurre.
    recovering = name == "RECOVERY"
    recovery_from = rng.randint(2, 5) if recovering else None

    rows = []
    hist = {"approval": [], "latency": [], "provider_fail": []}

    for step in range(STEPS_PER_EPISODE):
        at = anchor + timedelta(minutes=step * STEP_MINUTES)
        temporal = encode_local_time(at, tz_name)
        local_hour = temporal["local_hour"]

        # Volumen NOCTURNO BAJO. Esto es evidencia, no riesgo: el modelo no
        # debe aprender "poco trafico = degradacion".
        attempts = max(15, int(rng.gauss(160 * diurnal_volume(local_hour), 35)))

        intensity = 0.0
        if degrades and onset is not None:
            if step >= onset:
                intensity = clip((step - onset + 1) / 3.0, 0.0, 1.0)
            elif cfg["lead"] > 0 and step >= onset - cfg["lead"]:
                # precursor: la degradacion asoma antes de romper la conversion
                lead_pos = (step - (onset - cfg["lead"]) + 1) / (cfg["lead"] + 1)
                intensity = 0.55 * lead_pos * rng.uniform(0.7, 1.15)

        if recovering:
            intensity = clip(0.9 - step / max(1, recovery_from * 2), 0.0, 0.9)

        mix = mix_for_step(cfg, intensity)
        counts = sample_counts(mix, attempts, rng)
        m = derive(counts, attempts)

        # La conversion observada mezcla el baseline del segmento con la mezcla
        # simulada, mas ruido de muestreo.
        approval = clip(
            m["approval_rate"] * (baseline / HEALTHY["SUCCEEDED"])
            + diurnal_approval_shift(local_hour)
            + rng.gauss(0, 0.012),
            0.0,
            1.0,
        )

        latency = base_latency + diurnal_latency_shift(local_hour) + rng.gauss(0, 45)
        latency += cfg["latency"] * intensity * rng.uniform(1400, 3000)
        latency = max(120.0, latency)

        provider_fail = m["provider_error_rate"] + m["provider_timeout_rate"]

        hist["approval"].append(approval)
        hist["latency"].append(latency)
        hist["provider_fail"].append(provider_fail)

        expected_now = baseline + diurnal_approval_shift(local_hour)

        if step >= 2:
            approval_slope = (hist["approval"][step] - hist["approval"][step - 2]) / 2
            latency_slope = (hist["latency"][step] - hist["latency"][step - 2]) / 2
            provider_failure_slope = (hist["provider_fail"][step] - hist["provider_fail"][step - 2]) / 2
        else:
            approval_slope = latency_slope = provider_failure_slope = 0.0

        # OJO: el umbral de "ya degradado" se compara contra el baseline
        # AJUSTADO por hora local. Si se comparara contra el baseline global,
        # la noche sana entraria como degradacion y el label quedaria sesgado.
        # BASELINE CONDICIONADO A LA HORA LOCAL (Opcion B del analisis temporal).
        # Medido primero con baseline global: la noche sana alertaba 7,75 pp mas
        # que el dia. Un modelo lineal con sin/cos no puede cancelar la
        # interaccion entre hora y caida de aprobacion; el baseline comparable
        # por hora local si la elimina en origen.
        already_degraded = approval < expected_now - DEGRADATION_DROP

        will_degrade = 0
        if degrades and onset is not None and not already_degraded:
            if 0 < (onset - step) <= PREDICTION_STEPS:
                will_degrade = 1

        # proporcion de intentos que son reintento (attemptNumber > 1)
        retry_attempt_rate = clip(0.08 + 0.35 * intensity + rng.gauss(0, 0.02), 0.0, 0.9)

        rows.append({
            "episode_id": episode_id,
            "step": step,
            "scenario": name,
            "country": country,
            "time_zone": tz_name,
            "local_hour": local_hour,
            "daypart": daypart_of(local_hour),
            "attempts": attempts,
            "local_time_sin": round(temporal["local_time_sin"], 6),
            "local_time_cos": round(temporal["local_time_cos"], 6),
            "baseline_approval_rate": round(expected_now, 6),
            "approval_drop": round(max(0.0, expected_now - approval), 6),
            "approval_slope": round(approval_slope, 6),
            "p95_latency_ms": round(latency, 3),
            "latency_slope": round(latency_slope, 4),
            "provider_error_rate": round(m["provider_error_rate"], 6),
            "provider_timeout_rate": round(m["provider_timeout_rate"], 6),
            "provider_failure_slope": round(provider_failure_slope, 6),
            "rejected_rate": round(m["rejected_rate"], 6),
            "issuer_decline_rate": round(m["issuer_decline_rate"], 6),
            "auth_3ds_failure_rate": round(m["auth_3ds_failure_rate"], 6),
            "fraud_screening_failure_rate": round(m["fraud_screening_failure_rate"], 6),
            "data_quality_failure_rate": round(m["data_quality_failure_rate"], 6),
            "provider_config_failure_rate": round(m["provider_config_failure_rate"], 6),
            "hard_decline_share": round(m["hard_decline_share"], 6),
            "retry_attempt_rate": round(retry_attempt_rate, 6),
            "already_degraded": int(already_degraded),
            "will_degrade_within_15m": will_degrade,
        })

    return rows


def main():
    all_rows = []
    for episode_id in range(EPISODES):
        all_rows.extend(generate_episode(episode_id))

    # El predictor es PREVENTIVO: las filas donde la degradacion ya ocurrio no
    # entrenan al modelo.
    usable = [r for r in all_rows if r["already_degraded"] == 0]

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(usable[0].keys()))
        writer.writeheader()
        writer.writerows(usable)

    positives = sum(r["will_degrade_within_15m"] for r in usable)
    print(f"Episodios: {EPISODES}")
    print(f"Filas generadas: {len(all_rows)}")
    print(f"Filas usables (pre-degradacion): {len(usable)}")
    print(f"Positivos: {positives} ({positives / len(usable):.3%})")
    print(f"Salida: {OUTPUT}")

    # --- Diagnostico de fuga: prevalencia del target por daypart y por hora ---
    print("\nPrevalencia del target por daypart (no debe concentrarse):")
    by_daypart = {}
    for r in usable:
        d = by_daypart.setdefault(r["daypart"], [0, 0])
        d[0] += 1
        d[1] += r["will_degrade_within_15m"]
    for daypart in ["NIGHT", "MORNING", "AFTERNOON", "EVENING"]:
        total, pos = by_daypart.get(daypart, [0, 0])
        if total:
            print(f"  {daypart:<10} filas={total:<7} positivos={pos:<6} prevalencia={pos/total:.3%}")

    print("\nPrevalencia por hora local (max - min debe ser pequena):")
    by_hour = {}
    for r in usable:
        h = by_hour.setdefault(r["local_hour"], [0, 0])
        h[0] += 1
        h[1] += r["will_degrade_within_15m"]
    rates = {h: v[1] / v[0] for h, v in by_hour.items() if v[0] > 50}
    if rates:
        lo = min(rates.items(), key=lambda x: x[1])
        hi = max(rates.items(), key=lambda x: x[1])
        print(f"  minima  hora {lo[0]:02d}h -> {lo[1]:.3%}")
        print(f"  maxima  hora {hi[0]:02d}h -> {hi[1]:.3%}")
        print(f"  rango   {hi[1] - lo[1]:.3%}")

    print("\nEscenarios por daypart (deben estar repartidos):")
    grid = {}
    for r in usable:
        grid[(r["scenario"], r["daypart"])] = grid.get((r["scenario"], r["daypart"]), 0) + 1
    for scenario in sorted({r["scenario"] for r in usable}):
        cells = [grid.get((scenario, d), 0) for d in ["NIGHT", "MORNING", "AFTERNOON", "EVENING"]]
        print(f"  {scenario:<34} {cells}")

    by_scenario = {}
    for r in usable:
        s = by_scenario.setdefault(r["scenario"], [0, 0])
        s[0] += 1
        s[1] += r["will_degrade_within_15m"]
    print("\nEscenario                            filas   positivos")
    for name in sorted(by_scenario):
        total, pos = by_scenario[name]
        print(f"  {name:<34} {total:>6}   {pos:>6}")


if __name__ == "__main__":
    main()
