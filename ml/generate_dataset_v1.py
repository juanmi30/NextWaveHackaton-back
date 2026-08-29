from pathlib import Path

import numpy as np
import pandas as pd


RANDOM_SEED = 42
N_SAMPLES = 12000

OUTPUT_PATH = Path(__file__).parent / "data" / "training.csv"

rng = np.random.default_rng(RANDOM_SEED)


def clip(value, low, high):
    return float(np.clip(value, low, high))


def generate_normal():
    baseline = rng.uniform(0.86, 0.96)

    approval_rate = clip(
        baseline + rng.normal(0, 0.025),
        0.65,
        0.99,
    )

    timeout_rate = clip(
        rng.normal(0.015, 0.012),
        0,
        0.08,
    )

    error_rate = clip(
        rng.normal(0.02, 0.015),
        0,
        0.10,
    )

    p95_latency = clip(
        rng.normal(550, 180),
        150,
        1500,
    )

    return {
        "approval_rate": approval_rate,
        "baseline_approval_rate": baseline,
        "approval_drop": max(0, baseline - approval_rate),
        "approval_slope": rng.normal(0, 0.018),
        "timeout_rate": timeout_rate,
        "timeout_slope": rng.normal(0, 0.008),
        "error_rate": error_rate,
        "p95_latency_ms": p95_latency,
        "latency_slope": rng.normal(0, 80),
        "attempts": int(rng.integers(20, 250)),
        "will_fail": 0,
    }


def generate_pre_failure():
    baseline = rng.uniform(0.86, 0.96)

    severity = rng.uniform(0.25, 1.0)

    approval_drop = clip(
        rng.normal(0.04 + severity * 0.09, 0.03),
        0,
        0.22,
    )

    approval_rate = clip(
        baseline - approval_drop,
        0.55,
        0.97,
    )

    approval_slope = rng.normal(
        -0.025 - severity * 0.06,
        0.025,
    )

    timeout_rate = clip(
        rng.normal(0.02 + severity * 0.07, 0.025),
        0,
        0.25,
    )

    timeout_slope = rng.normal(
        0.008 + severity * 0.025,
        0.012,
    )

    error_rate = clip(
        rng.normal(0.025 + severity * 0.06, 0.025),
        0,
        0.25,
    )

    p95_latency = clip(
        rng.normal(600 + severity * 900, 300),
        200,
        3500,
    )

    latency_slope = rng.normal(
        80 + severity * 400,
        160,
    )

    return {
        "approval_rate": approval_rate,
        "baseline_approval_rate": baseline,
        "approval_drop": max(0, baseline - approval_rate),
        "approval_slope": approval_slope,
        "timeout_rate": timeout_rate,
        "timeout_slope": timeout_slope,
        "error_rate": error_rate,
        "p95_latency_ms": p95_latency,
        "latency_slope": latency_slope,
        "attempts": int(rng.integers(20, 250)),
        "will_fail": 1,
    }


def generate_noisy_recovery():
    """
    Tráfico que parece peligroso pero finalmente se recupera.

    Es muy importante para que el modelo no aprenda:
    'cualquier métrica fea = fallo'.
    """
    baseline = rng.uniform(0.86, 0.96)

    approval_drop = rng.uniform(0.03, 0.12)

    return {
        "approval_rate": clip(
            baseline - approval_drop,
            0.65,
            0.96,
        ),
        "baseline_approval_rate": baseline,
        "approval_drop": approval_drop,
        "approval_slope": rng.normal(0.005, 0.025),
        "timeout_rate": clip(
            rng.normal(0.04, 0.025),
            0,
            0.16,
        ),
        "timeout_slope": rng.normal(-0.005, 0.012),
        "error_rate": clip(
            rng.normal(0.04, 0.025),
            0,
            0.15,
        ),
        "p95_latency_ms": clip(
            rng.normal(950, 300),
            250,
            2500,
        ),
        "latency_slope": rng.normal(-60, 120),
        "attempts": int(rng.integers(20, 250)),
        "will_fail": 0,
    }


def main():
    rows = []

    for _ in range(N_SAMPLES):
        roll = rng.random()

        if roll < 0.60:
            rows.append(generate_normal())

        elif roll < 0.78:
            rows.append(generate_noisy_recovery())

        else:
            rows.append(generate_pre_failure())

    df = pd.DataFrame(rows)

    OUTPUT_PATH.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    df.to_csv(
        OUTPUT_PATH,
        index=False,
    )

    print(f"Dataset generado: {OUTPUT_PATH}")
    print(f"Filas: {len(df)}")

    print("\nDistribución:")
    print(df["will_fail"].value_counts())
    print()

    print("Porcentaje:")
    print(df["will_fail"].value_counts(normalize=True))


if __name__ == "__main__":
    main()