from pathlib import Path

import numpy as np
import pandas as pd


RANDOM_SEED = 42

N_EPISODES = 1600
STEPS_PER_EPISODE = 18
STEP_MINUTES = 5
PREDICTION_HORIZON_MINUTES = 15
PREDICTION_STEPS = (
    PREDICTION_HORIZON_MINUTES // STEP_MINUTES
)

OUTPUT_PATH = (
    Path(__file__).parent
    / "data"
    / "training.csv"
)

rng = np.random.default_rng(RANDOM_SEED)


def clip(value, low, high):
    return float(np.clip(value, low, high))


def generate_episode(episode_id: int):
    scenario = rng.choice(
        [
            "normal",
            "recovery",
            "gradual_failure",
            "sudden_failure",
        ],
        p=[
            0.45,
            0.25,
            0.23,
            0.07,
        ],
    )

    baseline = rng.uniform(0.86, 0.96)

    base_latency = rng.uniform(300, 700)
    base_timeout = rng.uniform(0.005, 0.03)
    base_error = rng.uniform(0.005, 0.04)

    failure_step = None

    if scenario in {
        "gradual_failure",
        "sudden_failure",
    }:
        failure_step = int(
            rng.integers(
                10,
                STEPS_PER_EPISODE,
            )
        )

    if scenario == "recovery":
        stress_start = int(
            rng.integers(5, 10)
        )
        stress_peak = min(
            stress_start
            + int(rng.integers(2, 5)),
            STEPS_PER_EPISODE - 2,
        )
    else:
        stress_start = None
        stress_peak = None

    rows = []

    approval_history = []
    timeout_history = []
    latency_history = []

    for step in range(STEPS_PER_EPISODE):

        stress = 0.0

        # -----------------------------------------------------
        # Gradual failure:
        # deterioration starts several windows before failure.
        # -----------------------------------------------------

        if (
            scenario == "gradual_failure"
            and failure_step is not None
        ):
            warning_start = failure_step - int(
                rng.integers(3, 7)
            )

            if step >= warning_start:
                denominator = max(
                    failure_step - warning_start,
                    1,
                )

                stress = (
                    step - warning_start + 1
                ) / denominator

                stress = clip(
                    stress,
                    0,
                    1.4,
                )

        # -----------------------------------------------------
        # Recovery:
        # looks dangerous, but returns to normal.
        # -----------------------------------------------------

        elif scenario == "recovery":
            if (
                stress_start is not None
                and stress_peak is not None
            ):
                if stress_start <= step <= stress_peak:
                    denominator = max(
                        stress_peak - stress_start,
                        1,
                    )

                    stress = (
                        step - stress_start + 1
                    ) / (denominator + 1)

                elif step > stress_peak:
                    stress = max(
                        0,
                        1
                        - (
                            step - stress_peak
                        )
                        / 3,
                    )

        # -----------------------------------------------------
        # Sudden failure:
        # basically no predictive signal before the event.
        # -----------------------------------------------------

        elif (
            scenario == "sudden_failure"
            and failure_step is not None
        ):
            if step >= failure_step:
                stress = rng.uniform(0.9, 1.3)

        # -----------------------------------------------------
        # Small real-world-like noise.
        # -----------------------------------------------------

        approval_noise = rng.normal(
            0,
            0.018,
        )

        timeout_noise = rng.normal(
            0,
            0.008,
        )

        error_noise = rng.normal(
            0,
            0.010,
        )

        latency_noise = rng.normal(
            0,
            90,
        )

        approval_rate = clip(
            baseline
            - stress * rng.uniform(0.08, 0.20)
            + approval_noise,
            0.30,
            0.99,
        )

        timeout_rate = clip(
            base_timeout
            + stress * rng.uniform(0.03, 0.15)
            + timeout_noise,
            0,
            0.40,
        )

        error_rate = clip(
            base_error
            + stress * rng.uniform(0.02, 0.12)
            + error_noise,
            0,
            0.40,
        )

        p95_latency = clip(
            base_latency
            + stress * rng.uniform(400, 1800)
            + latency_noise,
            100,
            5000,
        )

        approval_history.append(
            approval_rate
        )
        timeout_history.append(
            timeout_rate
        )
        latency_history.append(
            p95_latency
        )

        # Slopes based only on information available NOW.
        if step >= 2:
            approval_slope = (
                approval_history[step]
                - approval_history[step - 2]
            ) / 2

            timeout_slope = (
                timeout_history[step]
                - timeout_history[step - 2]
            ) / 2

            latency_slope = (
                latency_history[step]
                - latency_history[step - 2]
            ) / 2

        else:
            approval_slope = 0.0
            timeout_slope = 0.0
            latency_slope = 0.0

        approval_drop = max(
            0,
            baseline - approval_rate,
        )

        attempts = int(
            rng.integers(20, 250)
        )

        # -----------------------------------------------------
        # Target:
        # Will a real failure occur in the next 15 minutes?
        #
        # IMPORTANT:
        # A row where the failure has already happened is
        # excluded later. This model is predictive, not reactive.
        # -----------------------------------------------------

        will_fail = 0

        if failure_step is not None:
            distance = failure_step - step

            if (
                0 < distance
                <= PREDICTION_STEPS
            ):
                will_fail = 1

        already_failed = (
            failure_step is not None
            and step >= failure_step
        )

        rows.append(
            {
                "episode_id": episode_id,
                "step": step,
                "scenario": scenario,
                "baseline_approval_rate": baseline,
                "approval_drop": approval_drop,
                "approval_slope": approval_slope,
                "timeout_rate": timeout_rate,
                "timeout_slope": timeout_slope,
                "error_rate": error_rate,
                "p95_latency_ms": p95_latency,
                "latency_slope": latency_slope,
                "attempts": attempts,
                "will_fail": will_fail,
                "already_failed": int(
                    already_failed
                ),
            }
        )

    return rows


def main():
    rows = []

    for episode_id in range(N_EPISODES):
        rows.extend(
            generate_episode(
                episode_id
            )
        )

    df = pd.DataFrame(rows)

    # Predictive model should NEVER train on an already
    # failed service.
    df = df[
        df["already_failed"] == 0
    ].copy()

    df.drop(
        columns=["already_failed"],
        inplace=True,
    )

    OUTPUT_PATH.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    df.to_csv(
        OUTPUT_PATH,
        index=False,
    )

    print(
        f"Dataset generado: {OUTPUT_PATH}"
    )

    print(
        f"Filas: {len(df)}"
    )

    print(
        f"Episodios: "
        f"{df['episode_id'].nunique()}"
    )

    print("\nEscenarios:")
    print(
        df["scenario"].value_counts()
    )

    print("\nTarget:")
    print(
        df["will_fail"].value_counts()
    )

    print("\nProporción target:")
    print(
        df["will_fail"]
        .value_counts(
            normalize=True
        )
    )


if __name__ == "__main__":
    main()