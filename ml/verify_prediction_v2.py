"""
Verificacion de paridad Python <-> TypeScript para el artefacto V2.

Comprueba dos cosas:
  1. que el orden de features del artefacto coincide con V2_FEATURES en
     src/modules/prediction/feature-vector-v2.ts;
  2. que la puntuacion (scaler + regresion + sigmoide) da el mismo numero en
     ambos lados para vectores de prueba, incluida la codificacion temporal.

Imprime los vectores y el score esperado para que el test de TypeScript los use.
"""

import json
import math
from datetime import datetime, timezone
from pathlib import Path

from local_time import encode_local_time

ARTIFACT = Path(__file__).parent / "artifacts" / "failure_prediction_v2.json"
TS_FEATURES_FILE = (
    Path(__file__).parent.parent / "src" / "modules" / "prediction" / "feature-vector-v2.ts"
)

artifact = json.loads(ARTIFACT.read_text(encoding="utf-8"))
FEATURES = artifact["features"]


def score(values):
    mean = artifact["scaler"]["mean"]
    scale = artifact["scaler"]["scale"]
    coef = artifact["model"]["coefficients"]
    logit = artifact["model"]["intercept"]
    for i, feature in enumerate(FEATURES):
        raw = values[feature]
        z = (raw - mean[i]) / scale[i] if scale[i] != 0 else raw - mean[i]
        logit += z * coef[i]
    return 1 / (1 + math.exp(-logit))


def check_feature_order():
    source = TS_FEATURES_FILE.read_text(encoding="utf-8")
    block = source.split("export const V2_FEATURES = [")[1].split("] as const;")[0]
    ts_features = [
        line.strip().strip(",").strip("'")
        for line in block.splitlines()
        if line.strip().startswith("'")
    ]
    if ts_features != FEATURES:
        print("FALLO: el orden de features no coincide")
        print("  artefacto :", FEATURES)
        print("  typescript:", ts_features)
        return False
    print(f"OK  orden de features identico ({len(FEATURES)} features)")
    return True


CASES = [
    {
        "name": "ruta sana de madrugada en Bogota",
        "at": "2026-08-30T07:00:00Z",
        "tz": "America/Bogota",
        "values": {
            "baseline_approval_rate": 0.88,
            "approval_drop": 0.005,
            "approval_slope": 0.0,
            "p95_latency_ms": 640.0,
            "latency_slope": 2.0,
            "provider_error_rate": 0.004,
            "provider_timeout_rate": 0.003,
            "provider_failure_slope": 0.0,
            "rejected_rate": 0.003,
            "issuer_decline_rate": 0.05,
            "auth_3ds_failure_rate": 0.004,
            "fraud_screening_failure_rate": 0.005,
            "data_quality_failure_rate": 0.01,
            "provider_config_failure_rate": 0.0,
            "hard_decline_share": 0.2,
            "retry_attempt_rate": 0.08,
        },
    },
    {
        "name": "degradacion de latencia en Sao Paulo por la tarde",
        "at": "2026-08-30T18:30:00Z",
        "tz": "America/Sao_Paulo",
        "values": {
            "baseline_approval_rate": 0.92,
            "approval_drop": 0.06,
            "approval_slope": -0.03,
            "p95_latency_ms": 2400.0,
            "latency_slope": 420.0,
            "provider_error_rate": 0.04,
            "provider_timeout_rate": 0.05,
            "provider_failure_slope": 0.02,
            "rejected_rate": 0.004,
            "issuer_decline_rate": 0.03,
            "auth_3ds_failure_rate": 0.004,
            "fraud_screening_failure_rate": 0.003,
            "data_quality_failure_rate": 0.008,
            "provider_config_failure_rate": 0.0,
            "hard_decline_share": 0.15,
            "retry_attempt_rate": 0.22,
        },
    },
    {
        "name": "misma hora local (02:00) en Madrid — invariancia de fase",
        "at": "2026-08-30T00:00:00Z",
        "tz": "Europe/Madrid",
        "values": None,  # se copia del primer caso
    },
]


def main():
    ok = check_feature_order()

    print("\nVectores de prueba y score esperado (usar en el test de TypeScript):")
    exported = []
    for case in CASES:
        values = dict(case["values"] or CASES[0]["values"])
        at = datetime.fromisoformat(case["at"].replace("Z", "+00:00")).astimezone(timezone.utc)
        temporal = encode_local_time(at, case["tz"])
        values["local_time_sin"] = temporal["local_time_sin"]
        values["local_time_cos"] = temporal["local_time_cos"]

        probability = score(values)
        exported.append(
            {
                "name": case["name"],
                "at": case["at"],
                "timeZone": case["tz"],
                "localHour": temporal["local_hour"],
                "values": values,
                "expectedProbability": probability,
            }
        )
        print(f"  {case['name']}")
        print(f"    hora local = {temporal['local_hour']:02d}:{temporal['local_minute']:02d}")
        print(f"    sin = {temporal['local_time_sin']:.12f}  cos = {temporal['local_time_cos']:.12f}")
        print(f"    probabilidad = {probability:.12f}")

    # Invariancia de fase: mismos operativos + misma hora local = mismo score.
    a, b = exported[0], exported[2]
    delta = abs(a["expectedProbability"] - b["expectedProbability"])
    print(f"\nInvariancia de fase (02:00 Bogota vs 02:00 Madrid): delta = {delta:.2e}")
    if delta > 1e-9:
        print("FALLO: la misma hora local con las mismas señales deberia puntuar igual")
        ok = False
    else:
        print("OK  la misma fase local produce la misma prediccion")

    out = Path(__file__).parent / "artifacts" / "parity_vectors_v2.json"
    out.write_text(json.dumps(exported, indent=2), encoding="utf-8")
    print(f"\nVectores exportados a {out}")
    print("\nRESULTADO:", "OK" if ok else "FALLO")
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    main()
