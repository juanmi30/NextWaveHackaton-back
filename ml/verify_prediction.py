from pathlib import Path
import json
import math


BASE_DIR = Path(__file__).parent
MODEL_PATH = (
    BASE_DIR
    / "artifacts"
    / "failure_prediction_v1.json"
)


INPUT = {
    "baseline_approval_rate": 0.91,
    "approval_drop": 0.10,
    "approval_slope": -0.05,
    "timeout_rate": 0.08,
    "timeout_slope": 0.025,
    "error_rate": 0.07,
    "p95_latency_ms": 1400,
    "latency_slope": 350,
}


NESTJS_RESULT = 0.35572043756052363


def sigmoid(value: float) -> float:
    if value >= 0:
        return 1 / (1 + math.exp(-value))

    exp_value = math.exp(value)
    return exp_value / (1 + exp_value)


def main():
    with MODEL_PATH.open(
        "r",
        encoding="utf-8",
    ) as file:
        artifact = json.load(file)

    features = artifact["features"]
    means = artifact["scaler"]["mean"]
    scales = artifact["scaler"]["scale"]
    coefficients = artifact["model"]["coefficients"]
    intercept = artifact["model"]["intercept"]

    logit = intercept

    print("=" * 70)
    print("PYTHON ↔ NESTJS RUNTIME PARITY")
    print("=" * 70)

    print("\nFeature contributions:")

    for index, feature in enumerate(features):
        raw_value = INPUT[feature]

        mean = means[index]
        scale = scales[index]

        standardized = (
            raw_value - mean
            if scale == 0
            else (raw_value - mean) / scale
        )

        contribution = (
            standardized
            * coefficients[index]
        )

        logit += contribution

        print(
            f"{feature:<28}"
            f"raw={raw_value:<10.4f} "
            f"z={standardized:<10.4f} "
            f"contribution={contribution:.6f}"
        )

    probability = sigmoid(logit)

    difference = abs(
        probability - NESTJS_RESULT
    )

    print("\n" + "=" * 70)

    print(
        f"Python probability : "
        f"{probability:.15f}"
    )

    print(
        f"NestJS probability : "
        f"{NESTJS_RESULT:.15f}"
    )

    print(
        f"Absolute difference: "
        f"{difference:.15e}"
    )

    print()

    if difference < 1e-12:
        print("✅ PARITY CHECK PASSED")
    else:
        print("❌ PARITY CHECK FAILED")


if __name__ == "__main__":
    main()