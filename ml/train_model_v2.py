"""
Entrenamiento V2 — Logistic Regression interpretable para riesgo preventivo.

Split por EPISODIO (nunca por fila) en TRAIN / VALIDATION / TEST.
El threshold se elige mirando SOLO validation. Test se toca una unica vez.
"""

import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    average_precision_score,
    brier_score_loss,
    confusion_matrix,
    f1_score,
    fbeta_score,
    precision_score,
    recall_score,
    roc_auc_score,
)
from sklearn.model_selection import GroupShuffleSplit
from sklearn.preprocessing import StandardScaler

DATA = Path(__file__).parent / "data" / "training_v2.csv"
ARTIFACT = Path(__file__).parent / "artifacts" / "failure_prediction_v2.json"

TARGET = "will_degrade_within_15m"
GROUP = "episode_id"
RANDOM_SEED = 42

# 15 features. Orden CONGELADO: el runtime en TypeScript construye el vector
# exactamente en este orden.
FEATURES = [
    # Contexto temporal ciclico. Dos columnas, UN concepto logico.
    "local_time_sin",
    "local_time_cos",
    "baseline_approval_rate",
    "approval_drop",
    "approval_slope",
    "p95_latency_ms",
    "latency_slope",
    "provider_error_rate",
    "provider_timeout_rate",
    "provider_failure_slope",
    "rejected_rate",
    "issuer_decline_rate",
    "auth_3ds_failure_rate",
    "fraud_screening_failure_rate",
    "data_quality_failure_rate",
    "provider_config_failure_rate",
    "hard_decline_share",
    "retry_attempt_rate",
]

# El producto es preventivo: un falso negativo cuesta un incidente no anticipado,
# un falso positivo cuesta una revision. Se pondera recall por encima de
# precision, pero sin llegar a alertar de todo.
FBETA = 1.5
# Piso de precision: sin el, maximizar recall degenera en "alertar siempre".
MIN_PRECISION = 0.35


def split_by_episode(df):
    outer = GroupShuffleSplit(n_splits=1, test_size=0.20, random_state=RANDOM_SEED)
    rest_idx, test_idx = next(outer.split(df, groups=df[GROUP]))
    rest = df.iloc[rest_idx]
    test = df.iloc[test_idx]

    inner = GroupShuffleSplit(n_splits=1, test_size=0.20, random_state=RANDOM_SEED)
    train_idx, val_idx = next(inner.split(rest, groups=rest[GROUP]))
    return rest.iloc[train_idx], rest.iloc[val_idx], test


def report(name, y, p, threshold):
    pred = (p >= threshold).astype(int)
    tn, fp, fn, tp = confusion_matrix(y, pred, labels=[0, 1]).ravel()
    return {
        "split": name,
        "threshold": round(float(threshold), 4),
        "rocAuc": round(float(roc_auc_score(y, p)), 4),
        "averagePrecision": round(float(average_precision_score(y, p)), 4),
        "brierScore": round(float(brier_score_loss(y, p)), 5),
        "precision": round(float(precision_score(y, pred, zero_division=0)), 4),
        "recall": round(float(recall_score(y, pred, zero_division=0)), 4),
        "f1": round(float(f1_score(y, pred, zero_division=0)), 4),
        "fbeta": round(float(fbeta_score(y, pred, beta=FBETA, zero_division=0)), 4),
        "confusion": {"tn": int(tn), "fp": int(fp), "fn": int(fn), "tp": int(tp)},
    }


def main():
    df = pd.read_csv(DATA)
    missing = [c for c in FEATURES + [TARGET, GROUP, "scenario", "daypart", "local_hour", "time_zone"] if c not in df.columns]
    if missing:
        raise SystemExit(f"Faltan columnas en el dataset: {missing}")

    train, val, test = split_by_episode(df)
    print(f"Filas    train={len(train)}  val={len(val)}  test={len(test)}")
    print(f"Episodios train={train[GROUP].nunique()}  val={val[GROUP].nunique()}  test={test[GROUP].nunique()}")
    for name, part in (("train", train), ("val", val), ("test", test)):
        print(f"  positivos {name}: {part[TARGET].mean():.3%}")

    scaler = StandardScaler().fit(train[FEATURES])
    model = LogisticRegression(
        max_iter=3000,
        class_weight="balanced",
        random_state=RANDOM_SEED,
    ).fit(scaler.transform(train[FEATURES]), train[TARGET])

    p_val = model.predict_proba(scaler.transform(val[FEATURES]))[:, 1]
    p_test = model.predict_proba(scaler.transform(test[FEATURES]))[:, 1]

    # --- Threshold: se elige SOLO con validation ---
    print("\nBarrido de threshold (validation)")
    print("  thr   precision  recall     f1     f-beta2")
    sweep = []
    best = (None, -1.0)
    for thr in np.round(np.arange(0.05, 0.96, 0.05), 2):
        pred = (p_val >= thr).astype(int)
        pr = precision_score(val[TARGET], pred, zero_division=0)
        rc = recall_score(val[TARGET], pred, zero_division=0)
        f1 = f1_score(val[TARGET], pred, zero_division=0)
        fb = fbeta_score(val[TARGET], pred, beta=FBETA, zero_division=0)
        sweep.append({"threshold": float(thr), "precision": round(float(pr), 4),
                      "recall": round(float(rc), 4), "f1": round(float(f1), 4),
                      "fbeta": round(float(fb), 4)})
        print(f"  {thr:.2f}   {pr:.4f}    {rc:.4f}  {f1:.4f}  {fb:.4f}")
        if pr >= MIN_PRECISION and fb > best[1]:
            best = (float(thr), float(fb))

    if best[0] is None:
        # Ningun threshold alcanza el piso de precision: se elige el de mejor
        # F-beta y se deja constancia, en vez de fingir que hay uno bueno.
        best = max(((s["threshold"], s["fbeta"]) for s in sweep), key=lambda x: x[1])
        print("\nAVISO: ningun threshold alcanza el piso de precision.")

    threshold = best[0]
    print(f"\nThreshold elegido: max F-beta({FBETA}) con precision >= {MIN_PRECISION} en validation -> {threshold}")

    metrics = {
        "validation": report("validation", val[TARGET], p_val, threshold),
        "test": report("test", test[TARGET], p_test, threshold),
    }
    print("\nValidation:", json.dumps(metrics["validation"], indent=2))
    print("Test:      ", json.dumps(metrics["test"], indent=2))

    # --- Calibracion en test ---
    calibration = []
    bins = np.linspace(0, 1, 11)
    idx = np.digitize(p_test, bins) - 1
    for b in range(10):
        mask = idx == b
        if mask.sum() < 20:
            continue
        calibration.append({
            "bin": f"{bins[b]:.1f}-{bins[b+1]:.1f}",
            "count": int(mask.sum()),
            "meanPredicted": round(float(p_test[mask].mean()), 4),
            "observed": round(float(np.asarray(test[TARGET])[mask].mean()), 4),
        })
    print("\nCalibracion (test):")
    for row in calibration:
        print(f"  {row['bin']}  n={row['count']:<6} predicho={row['meanPredicted']:.3f}  observado={row['observed']:.3f}")

    # --- Metricas por escenario (test) ---
    per_scenario = []
    test_with_p = test.copy()
    test_with_p["p"] = p_test
    print("\nRecall por escenario (test):")
    for scenario, group in test_with_p.groupby("scenario"):
        positives = int(group[TARGET].sum())
        pred = (group["p"] >= threshold).astype(int)
        entry = {
            "scenario": scenario,
            "rows": int(len(group)),
            "positives": positives,
            "recall": round(float(recall_score(group[TARGET], pred, zero_division=0)), 4) if positives else None,
            "alertRate": round(float(pred.mean()), 4),
        }
        per_scenario.append(entry)
        detect = f"{entry['recall']:.3f}" if entry["recall"] is not None else "  n/a"
        print(f"  {scenario:<34} pos={positives:<5} recall={detect}  tasa_alerta={entry['alertRate']:.3f}")

    # --- Evaluacion temporal sobre el TEST intacto ---
    DAYPARTS = ["NIGHT", "MORNING", "AFTERNOON", "EVENING"]
    per_daypart = []
    print("\nMetricas por daypart (test):")
    print("  daypart     n      prev.    precision  recall   FPR     p_media")
    for daypart in DAYPARTS:
        g = test_with_p[test_with_p["daypart"] == daypart]
        if len(g) < 100:
            continue
        pred = (g["p"] >= threshold).astype(int)
        y = g[TARGET]
        negatives = int((y == 0).sum())
        fpr = float(((pred == 1) & (y == 0)).sum() / negatives) if negatives else 0.0
        entry = {
            "daypart": daypart,
            "rows": int(len(g)),
            "prevalence": round(float(y.mean()), 4),
            "precision": round(float(precision_score(y, pred, zero_division=0)), 4),
            "recall": round(float(recall_score(y, pred, zero_division=0)), 4),
            "falsePositiveRate": round(fpr, 4),
            "meanPredicted": round(float(g["p"].mean()), 4),
        }
        per_daypart.append(entry)
        print(f"  {daypart:<10} {entry['rows']:<6} {entry['prevalence']:.3f}    "
              f"{entry['precision']:.4f}     {entry['recall']:.4f}   {entry['falsePositiveRate']:.4f}  {entry['meanPredicted']:.4f}")

    # --- Criterio de aceptacion: la noche sana no debe alertar mas que el dia ---
    healthy_all = test_with_p[test_with_p["scenario"].isin(["NORMAL", "RECOVERY"])]
    night = healthy_all[healthy_all["daypart"] == "NIGHT"]
    day = healthy_all[healthy_all["daypart"] != "NIGHT"]
    night_fp = float((night["p"] >= threshold).mean()) if len(night) else 0.0
    day_fp = float((day["p"] >= threshold).mean()) if len(day) else 0.0
    print(f"\nFalsos positivos en trafico SANO:")
    print(f"  noche  = {night_fp:.4f}  (n={len(night)})")
    print(f"  dia    = {day_fp:.4f}  (n={len(day)})")
    print(f"  delta  = {night_fp - day_fp:+.4f}   <- cerca de 0 significa que la noche no penaliza")

    # El residuo nocturno puede ser sesgo temporal o simplemente MENOS MUESTRA.
    # Se separa aplicando la misma compuerta de evidencia que usa el runtime.
    EVIDENCE_MIN_ATTEMPTS = 60
    n_ev = night[night["attempts"] >= EVIDENCE_MIN_ATTEMPTS]
    d_ev = day[day["attempts"] >= EVIDENCE_MIN_ATTEMPTS]
    night_fp_ev = float((n_ev["p"] >= threshold).mean()) if len(n_ev) else 0.0
    day_fp_ev = float((d_ev["p"] >= threshold).mean()) if len(d_ev) else 0.0
    print(f"\nMismo calculo SOLO con evidencia suficiente (>= {EVIDENCE_MIN_ATTEMPTS} intentos):")
    print(f"  noche  = {night_fp_ev:.4f}  (n={len(n_ev)})")
    print(f"  dia    = {day_fp_ev:.4f}  (n={len(d_ev)})")
    print(f"  delta  = {night_fp_ev - day_fp_ev:+.4f}")
    print("  Si el delta se colapsa aqui, el residuo era tamano de muestra, no")
    print("  sesgo horario, y la compuerta de evidencia es la respuesta correcta.")

    # --- Generalizacion entre zonas horarias ---
    print("\nFalsos positivos en trafico sano por zona horaria:")
    per_timezone = []
    for tz, g in healthy_all.groupby("time_zone"):
        if len(g) < 100:
            continue
        rate = float((g["p"] >= threshold).mean())
        per_timezone.append({"timeZone": tz, "rows": int(len(g)), "falsePositiveRate": round(rate, 4)})
        print(f"  {tz:<32} n={len(g):<6} FP={rate:.4f}")

    healthy = healthy_all
    false_alarm_rate = float((healthy["p"] >= threshold).mean()) if len(healthy) else 0.0
    print(f"\nTasa de falsa alarma en NORMAL+RECOVERY (test): {false_alarm_rate:.4f}")

    predictable = test_with_p[~test_with_p["scenario"].isin(
        ["NORMAL", "RECOVERY", "SUDDEN_FAILURE", "PROVIDER_CONFIGURATION_FAILURE"])]
    auc_predictable = float(roc_auc_score(predictable[TARGET], predictable["p"])) if predictable[TARGET].nunique() > 1 else None
    print(f"ROC-AUC excluyendo lo no anticipable por diseno: {auc_predictable:.4f}")

    # --- Coeficientes ---
    coefs = sorted(
        [{"feature": f, "coefficient": round(float(c), 5)}
         for f, c in zip(FEATURES, model.coef_[0])],
        key=lambda x: abs(x["coefficient"]),
        reverse=True,
    )
    print("\nCoeficientes (escala estandarizada):")
    for c in coefs:
        print(f"  {c['feature']:<32} {c['coefficient']:+.5f}")

    artifact = {
        "modelType": "logistic_regression",
        "modelVersion": "2.0.0",
        "target": TARGET,
        "predictionHorizonMinutes": 15,
        "bucketMinutes": 5,
        "bucketCount": 3,
        "decisionThreshold": threshold,
        "thresholdCriterion": f"max F-beta(beta={FBETA}) sobre validation",
        "features": FEATURES,
        "scaler": {
            "mean": [float(x) for x in scaler.mean_],
            "scale": [float(x) for x in scaler.scale_],
        },
        "model": {
            "intercept": float(model.intercept_[0]),
            "coefficients": [float(x) for x in model.coef_[0]],
        },
        "metrics": metrics,
        "calibration": calibration,
        "perScenario": per_scenario,
        "perDaypart": per_daypart,
        "perTimeZoneHealthy": per_timezone,
        "healthyFalsePositiveNight": round(night_fp, 4),
        "healthyFalsePositiveDay": round(day_fp, 4),
        "healthyFalsePositiveNightWithEvidence": round(night_fp_ev, 4),
        "healthyFalsePositiveDayWithEvidence": round(day_fp_ev, 4),
        "evidenceGateAttempts": EVIDENCE_MIN_ATTEMPTS,
        "falseAlarmRateHealthyScenarios": round(false_alarm_rate, 4),
        "rocAucPredictableScenarios": round(auc_predictable, 4) if auc_predictable else None,
        "minPrecisionFloor": MIN_PRECISION,
        "thresholdSweep": sweep,
        "coefficients": coefs,
        "training": {
            "datasetRows": int(len(df)),
            "trainRows": int(len(train)),
            "validationRows": int(len(val)),
            "testRows": int(len(test)),
            "positiveRate": round(float(df[TARGET].mean()), 5),
            "randomSeed": RANDOM_SEED,
            "splitStrategy": "GroupShuffleSplit por episode_id, 64/16/20",
        },
        "temporalContext": {
            "encoding": "LOCAL_TIME_SIN_COS",
            "periodMinutes": 1440,
            "timezoneSemantics": "route_local_time",
            "anchor": "final de la ventana de observacion reciente",
            "formula": "angle = 2*pi*(hour*60+minute)/1440; sin(angle), cos(angle)",
            "note": "El perfil diurno del dataset es un SUPUESTO DE SIMULACION, no un dato publicado por Yuno.",
        },
        "documentation": "https://docs.y.uno/reference/payments/status-and-response-codes/transaction",
    }

    ARTIFACT.parent.mkdir(parents=True, exist_ok=True)
    ARTIFACT.write_text(json.dumps(artifact, indent=2), encoding="utf-8")
    print(f"\nArtefacto: {ARTIFACT}")


if __name__ == "__main__":
    main()
