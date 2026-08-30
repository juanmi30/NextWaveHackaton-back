import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { V2_FEATURES } from './feature-vector-v2.js';
import { encodeLocalTime } from '../../common/local-time.js';

const artifactPath = resolve(process.cwd(), 'ml', 'artifacts', 'failure_prediction_v2.json');
const vectorsPath = resolve(process.cwd(), 'ml', 'artifacts', 'parity_vectors_v2.json');

type Artifact = {
  features: string[];
  scaler: { mean: number[]; scale: number[] };
  model: { intercept: number; coefficients: number[] };
  decisionThreshold: number;
  temporalContext?: Record<string, unknown>;
};

const artifact = JSON.parse(readFileSync(artifactPath, 'utf-8')) as Artifact;
const vectors = JSON.parse(readFileSync(vectorsPath, 'utf-8')) as Array<{
  name: string;
  at: string;
  timeZone: string;
  localHour: number;
  values: Record<string, number>;
  expectedProbability: number;
}>;

/** Misma aritmetica que PredictionService.score, aislada para el test. */
function score(values: Record<string, number>): number {
  let logit = artifact.model.intercept;
  artifact.features.forEach((feature, index) => {
    const raw = values[feature]!;
    const mean = artifact.scaler.mean[index]!;
    const scale = artifact.scaler.scale[index]!;
    const z = scale === 0 ? raw - mean : (raw - mean) / scale;
    logit += z * artifact.model.coefficients[index]!;
  });
  return 1 / (1 + Math.exp(-logit));
}

describe('paridad artefacto V2 <-> runtime', () => {
  it('el orden de features del artefacto coincide con V2_FEATURES', () => {
    expect(artifact.features).toEqual([...V2_FEATURES]);
  });

  it('el artefacto documenta la semantica temporal', () => {
    expect(artifact.temporalContext?.encoding).toBe('LOCAL_TIME_SIN_COS');
    expect(artifact.temporalContext?.periodMinutes).toBe(1440);
  });

  it('la codificacion temporal de TypeScript reproduce la de Python', () => {
    for (const vector of vectors) {
      const encoded = encodeLocalTime(new Date(vector.at), vector.timeZone);
      expect(encoded.localHour).toBe(vector.localHour);
      expect(encoded.localTimeSin).toBeCloseTo(vector.values.local_time_sin!, 10);
      expect(encoded.localTimeCos).toBeCloseTo(vector.values.local_time_cos!, 10);
    }
  });

  it('el score de TypeScript coincide con el de Python', () => {
    for (const vector of vectors) {
      expect(score(vector.values)).toBeCloseTo(vector.expectedProbability, 10);
    }
  });

  it('la ruta sana de madrugada no supera el umbral de decision', () => {
    const healthyNight = vectors.find((v) => v.localHour < 6)!;
    expect(healthyNight.expectedProbability).toBeLessThan(artifact.decisionThreshold);
  });

  it('la degradacion de proveedor si lo supera', () => {
    const degraded = vectors.find((v) => v.values.latency_slope! > 100)!;
    expect(degraded.expectedProbability).toBeGreaterThan(artifact.decisionThreshold);
  });
});
