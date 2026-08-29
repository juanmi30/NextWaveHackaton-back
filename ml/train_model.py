from pathlib import Path
import json

import numpy as np
import pandas as pd
import sklearn
from sklearn.model_selection import GroupShuffleSplit

from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    classification_report,
    confusion_matrix,
    roc_auc_score,
    average_precision_score,
    brier_score_loss,
    precision_score,
    recall_score,
    f1_score,
)
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler
from sklearn.calibration import calibration_curve


RANDOM_SEED = 42
TEST_SIZE = 0.20
THRESHOLD = 0.15

BASE_DIR = Path(__file__).parent
DATASET_PATH = BASE_DIR / "data" / "training.csv"
ARTIFACTS_DIR = BASE_DIR / "artifacts"
MODEL_PATH = ARTIFACTS_DIR / "failure_prediction_v1.json"

TARGET = "will_fail"

FEATURES = [
    "baseline_approval_rate",
    "approval_drop",
    "approval_slope",
    "timeout_rate",
    "timeout_slope",
    "error_rate",
    "p95_latency_ms",
    "latency_slope",
]


def validate_dataset(df: pd.DataFrame):
    required_columns = FEATURES + [TARGET]

    missing = [
        column
        for column in required_columns
        if column not in df.columns
    ]

    if missing:
        raise ValueError(
            f"Faltan columnas en el dataset: {missing}"
        )

    if df[required_columns].isnull().any().any():
        raise ValueError(
            "El dataset contiene valores nulos."
        )

    invalid_targets = set(df[TARGET].unique()) - {0, 1}

    if invalid_targets:
        raise ValueError(
            f"Target inválido. Encontrados: {invalid_targets}"
        )


def main():
    print("=" * 70)
    print("NEXTWAVE - FAILURE PREDICTION MODEL")
    print("=" * 70)

    # ------------------------------------------------------------
    # 1. Cargar dataset
    # ------------------------------------------------------------

    df = pd.read_csv(DATASET_PATH)

    validate_dataset(df)

    print(f"\nDataset: {DATASET_PATH}")
    print(f"Filas: {len(df)}")
    print(f"Features: {len(FEATURES)}")

    print("\nDistribución del target:")
    print(df[TARGET].value_counts())

    print("\nProporción:")
    print(df[TARGET].value_counts(normalize=True))

    # ------------------------------------------------------------
    # 2. Separar X / y
    # ------------------------------------------------------------
    X = df[FEATURES]
    y = df[TARGET]
    groups = df["episode_id"]

    splitter = GroupShuffleSplit(
        n_splits=1,
        test_size=TEST_SIZE,
        random_state=RANDOM_SEED,
    )

    train_idx, test_idx = next(
        splitter.split(
            X,
            y,
            groups=groups,
        )
    )

    X_train = X.iloc[train_idx]
    X_test = X.iloc[test_idx]

    y_train = y.iloc[train_idx]
    y_test = y.iloc[test_idx]

    train_groups = set(
        groups.iloc[train_idx]
    )

    test_groups = set(
        groups.iloc[test_idx]
    )

    assert train_groups.isdisjoint(
        test_groups
    )

    print("\nSplit:")
    print(f"Train: {len(X_train)}")
    print(f"Test:  {len(X_test)}")

    print(
        f"Episodios train: "
        f"{len(train_groups)}"
    )

    print(
        f"Episodios test:  "
        f"{len(test_groups)}"
    )

    # ------------------------------------------------------------
    # 3. Escalado
    # ------------------------------------------------------------

    # MUY IMPORTANTE:
    # El scaler se entrena solamente con X_train.
    scaler = StandardScaler()

    X_train_scaled = scaler.fit_transform(X_train)
    X_test_scaled = scaler.transform(X_test)

    # ------------------------------------------------------------
    # 4. Entrenar regresión logística
    # ------------------------------------------------------------

    model = LogisticRegression(
        random_state=RANDOM_SEED,
        max_iter=1000,
    )

    model.fit(
        X_train_scaled,
        y_train,
    )

    # ------------------------------------------------------------
    # 5. Predicciones
    # ------------------------------------------------------------

    # Probabilidad de la clase positiva: will_fail = 1
    probabilities = model.predict_proba(
        X_test_scaled
    )[:, 1]

    print("\n" + "=" * 70)
    print("THRESHOLD ANALYSIS")
    print("=" * 70)

    thresholds_to_test = [
        0.10,
        0.15,
        0.20,
        0.25,
        0.30,
        0.35,
        0.40,
        0.45,
        0.50,
    ]

    threshold_results = []

    for threshold in thresholds_to_test:
        threshold_predictions = (
            probabilities >= threshold
        ).astype(int)

        precision = precision_score(
            y_test,
            threshold_predictions,
            zero_division=0,
        )

        recall = recall_score(
            y_test,
            threshold_predictions,
            zero_division=0,
        )

        f1 = f1_score(
            y_test,
            threshold_predictions,
            zero_division=0,
        )

        matrix_threshold = confusion_matrix(
            y_test,
            threshold_predictions,
        )

        tn_t, fp_t, fn_t, tp_t = (
            matrix_threshold.ravel()
        )

        threshold_results.append(
            {
                "threshold": threshold,
                "precision": precision,
                "recall": recall,
                "f1": f1,
                "false_positives": fp_t,
                "false_negatives": fn_t,
            }
        )

        print(
            f"threshold={threshold:.2f} | "
            f"precision={precision:.4f} | "
            f"recall={recall:.4f} | "
            f"f1={f1:.4f} | "
            f"FP={fp_t} | "
            f"FN={fn_t}"
        )

    predictions = (
        probabilities >= THRESHOLD
    ).astype(int)

    test_metadata = df.iloc[test_idx][
        [
            "episode_id",
            "scenario",
            "step",
        ]
    ].copy()

    test_metadata["y_true"] = (
        y_test.to_numpy()
    )

    test_metadata["probability"] = (
        probabilities
    )

    print("\n" + "=" * 70)
    print("PERFORMANCE BY SCENARIO")
    print("=" * 70)

    for scenario in [
        "gradual_failure",
        "sudden_failure",
    ]:
        scenario_df = test_metadata[
            test_metadata["scenario"]
            == scenario
        ]

        positive_rows = scenario_df[
            scenario_df["y_true"] == 1
        ]

        if len(positive_rows) == 0:
            continue

        detected = (
            positive_rows["probability"]
            >= THRESHOLD
        ).sum()

        recall_scenario = (
            detected
            / len(positive_rows)
        )

        avg_probability = (
            positive_rows["probability"]
            .mean()
        )

        print(
            f"\n{scenario}"
        )

        print(
            f"Positive windows: "
            f"{len(positive_rows)}"
        )

        print(
            f"Recall @ {THRESHOLD:.2f}: "
            f"{recall_scenario:.4f}"
        )

        print(
            f"Average predicted probability: "
            f"{avg_probability:.4f}"
        )

    print("\n" + "=" * 70)
    print("SCENARIO RECALL BY THRESHOLD")
    print("=" * 70)

    scenario_thresholds = [
        0.10,
        0.15,
        0.20,
        0.25,
        0.30,
        0.50,
    ]

    for threshold in scenario_thresholds:

        print(f"\nThreshold: {threshold:.2f}")

        for scenario in [
            "gradual_failure",
            "sudden_failure",
        ]:

            scenario_positive = test_metadata[
                (test_metadata["scenario"] == scenario)
                & (test_metadata["y_true"] == 1)
            ]

            if len(scenario_positive) == 0:
                continue

            detected = (
                scenario_positive["probability"]
                >= threshold
            ).sum()

            recall = (
                detected
                / len(scenario_positive)
            )

            print(
                f"{scenario:<20} "
                f"recall={recall:.4f} "
                f"({detected}/{len(scenario_positive)})"
            )

    print("\n" + "=" * 70)
    print("PROBABILITY CALIBRATION")
    print("=" * 70)

    prob_true, prob_pred = calibration_curve(
        y_test,
        probabilities,
        n_bins=8,
        strategy="quantile",
    )

    print(
        f"{'Predicted':>12} | "
        f"{'Observed':>12}"
    )

    print("-" * 29)

    for predicted, observed in zip(
        prob_pred,
        prob_true,
    ):
        print(
            f"{predicted:>12.4f} | "
            f"{observed:>12.4f}"
        )

    # ------------------------------------------------------------
    # 6. Métricas
    # ------------------------------------------------------------

    roc_auc = roc_auc_score(
        y_test,
        probabilities,
    )

    average_precision = average_precision_score(
        y_test,
        probabilities,
    )

    brier = brier_score_loss(
        y_test,
        probabilities,
    )

    matrix = confusion_matrix(
        y_test,
        predictions,
    )

    tn, fp, fn, tp = matrix.ravel()

    print("\n" + "=" * 70)
    print("RESULTADOS")
    print("=" * 70)

    print("\nClassification report:")
    print(
        classification_report(
            y_test,
            predictions,
            digits=4,
        )
    )

    print(f"ROC-AUC:           {roc_auc:.4f}")
    print(
        f"Average Precision: {average_precision:.4f}"
    )
    print(
        f"Brier Score:       {brier:.4f}"
    )

    print("\nConfusion matrix:")
    print(matrix)

    print("\nDetalle:")
    print(f"True negatives:  {tn}")
    print(f"False positives: {fp}")
    print(f"False negatives: {fn}")
    print(f"True positives:  {tp}")

    # ------------------------------------------------------------
    # 7. Ver qué aprendió el modelo
    # ------------------------------------------------------------

    coefficients = model.coef_[0]

    feature_importance = pd.DataFrame(
        {
            "feature": FEATURES,
            "coefficient": coefficients,
            "abs_coefficient": np.abs(coefficients),
        }
    ).sort_values(
        "abs_coefficient",
        ascending=False,
    )

    print("\n" + "=" * 70)
    print("COEFICIENTES DEL MODELO")
    print("=" * 70)

    for _, row in feature_importance.iterrows():
        direction = (
            "↑ aumenta riesgo"
            if row["coefficient"] > 0
            else "↓ reduce riesgo"
        )

        print(
            f"{row['feature']:<28}"
            f"{row['coefficient']:>9.4f}"
            f"   {direction}"
        )

    # ------------------------------------------------------------
    # 8. Exportar modelo a JSON
    # ------------------------------------------------------------

    ARTIFACTS_DIR.mkdir(
        parents=True,
        exist_ok=True,
    )

    artifact = {
        "modelType": "logistic_regression",
        "modelVersion": "1.0.0",
        "sklearnVersion": sklearn.__version__,
        "target": TARGET,
        "predictionHorizonMinutes": 15,
        "decisionThreshold": THRESHOLD,
        "features": FEATURES,
        "scaler": {
            "mean": scaler.mean_.tolist(),
            "scale": scaler.scale_.tolist(),
        },
        "model": {
            "intercept": float(
                model.intercept_[0]
            ),
            "coefficients": (
                model.coef_[0].tolist()
            ),
        },
        "metrics": {
            "rocAuc": float(roc_auc),
            "averagePrecision": float(
                average_precision
            ),
            "brierScore": float(brier),
            "trueNegatives": int(tn),
            "falsePositives": int(fp),
            "falseNegatives": int(fn),
            "truePositives": int(tp),
        },
        "training": {
            "datasetRows": int(len(df)),
            "trainRows": int(len(X_train)),
            "testRows": int(len(X_test)),
            "positiveRate": float(y.mean()),
            "randomSeed": RANDOM_SEED,
        },
    }

    with MODEL_PATH.open(
        "w",
        encoding="utf-8",
    ) as file:
        json.dump(
            artifact,
            file,
            indent=2,
        )

    print("\n" + "=" * 70)
    print("MODELO EXPORTADO")
    print("=" * 70)

    print(MODEL_PATH)


if __name__ == "__main__":
    main()