import {
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { EvaluatePredictionDto } from './dto/evaluate-prediction.dto.js';

import {
  PredictionFeaturesService,
  type ExtractedFeatures,
} from './prediction-features.service.js';

import type {
  EvaluateSegmentDto,
} from './dto/evaluate-segment.dto.js';

export type RiskLevel = 'LOW' | 'WATCH' | 'HIGH';

interface ModelArtifact {
  modelType: string;
  modelVersion: string;
  predictionHorizonMinutes: number;
  decisionThreshold: number;

  features: string[];

  scaler: {
    mean: number[];
    scale: number[];
  };

  model: {
    intercept: number;
    coefficients: number[];
  };
}

export interface Signal {
  feature: string;
  value: number;
  contribution: number;
  effect: 'INCREASES_RISK' | 'DECREASES_RISK';
}

export interface PredictionResult {
  model: {
    type: string;
    version: string;
  };

  predictionHorizonMinutes: number;

  failureProbability: number;
  failureProbabilityPercent: number;

  decisionThreshold: number;

  elevatedRisk: boolean;

  riskLevel: RiskLevel;

  signals: Signal[];
}

export interface SegmentPredictionResult {
  /** Contexto temporal local de la ruta. Nuevo en V2. */
  temporal?: unknown;

  /** Vector V2 tal como entro al modelo. Nuevo en V2. */
  featureVectorV2?: Record<string, number> | null;

  /** Contexto de fallo con semantica Yuno. Nuevo en V2. */
  yunoFailureContext?: unknown;

  /** Que baseline uso Prediction. Nuevo en V2. */
  baselineMode?: string;

  status:
    | 'PREDICTION'
    | 'INSUFFICIENT_EVIDENCE';

  segment: Record<
    string,
    string | undefined
  >;

  features:
    | ExtractedFeatures['modelInput']
    | null;

  evidence:
    ExtractedFeatures['evidence'];

  failureContext:
    ExtractedFeatures['failureContext'];

  prediction:
    PredictionResult | null;
}

export interface PredictionScanResult {
  scannedAt: string;

  evaluatedSegments: number;

  predictions: number;

  insufficientEvidence: number;

  watchRisks: Array<{
    segment: Record<
      string,
      string | undefined
    >;

    evidence:
      ExtractedFeatures['evidence'];

    features:
      ExtractedFeatures['modelInput'];

    failureContext:
      ExtractedFeatures['failureContext'];

    prediction: PredictionResult;
  }>;

  elevatedRisks: Array<{
    segment: Record<
      string,
      string | undefined
    >;

    evidence:
      ExtractedFeatures['evidence'];

    features:
      ExtractedFeatures['modelInput'];

    failureContext:
      ExtractedFeatures['failureContext'];

    prediction: PredictionResult;
  }>;
}

@Injectable()
export class PredictionService {
  private readonly artifact: ModelArtifact;

  constructor(
    private readonly featuresService:
      PredictionFeaturesService,
  ) {
    this.artifact = this.loadModel();
    this.validateArtifact();
  }

  /**
   * Puntua un vector completo de features V2.
   *
   * Es el camino que usa `evaluateSegment`: el extractor ya entrega el mapa
   * con los nombres exactos del artefacto.
   */
  scoreVector(
    input: Record<string, number>,
  ): PredictionResult {
    return this.score(input);
  }

  /**
   * Endpoint de compatibilidad. El DTO solo transporta las senales de V1, asi
   * que las features que falten se rellenan con la MEDIA del scaler: tras
   * estandarizar valen 0 y no aportan al logit. Es un valor neutro explicito,
   * no un cero disfrazado.
   */
  evaluate(
    input: EvaluatePredictionDto,
  ): PredictionResult {
    const values: Record<string, number> = {
      baseline_approval_rate:
        input.baselineApprovalRate,

      approval_drop:
        input.approvalDrop,

      approval_slope:
        input.approvalSlope,

      timeout_rate:
        input.timeoutRate,

      timeout_slope:
        input.timeoutSlope,

      error_rate:
        input.errorRate,

      p95_latency_ms:
        input.p95LatencyMs,

      latency_slope:
        input.latencySlope,
    };

    this.artifact.features.forEach(
      (feature, index) => {
        if (values[feature] === undefined) {
          values[feature] =
            this.artifact.scaler.mean[
              index
            ]!;
        }
      },
    );

    return this.score(values);
  }

  private score(
    values: Record<string, number>,
  ): PredictionResult {
    const standardized =
      this.artifact.features.map(
        (feature, index) => {
          const rawValue =
            values[feature];

          if (rawValue === undefined) {
            throw new InternalServerErrorException(
              `Feature no soportada por el runtime: ${feature}`,
            );
          }

          const mean =
            this.artifact.scaler.mean[
              index
            ];

          const scale =
            this.artifact.scaler.scale[
              index
            ];

          return scale === 0
            ? rawValue - mean
            : (rawValue - mean) /
                scale;
        },
      );

    let logit =
      this.artifact.model.intercept;

    const signals: Signal[] = [];

    for (
      let index = 0;
      index < standardized.length;
      index++
    ) {
      const coefficient =
        this.artifact.model
          .coefficients[index];

      const contribution =
        standardized[index] *
        coefficient;

      logit += contribution;

      const feature =
        this.artifact.features[index];

      signals.push({
        feature,

        value:
          values[feature],

        contribution,

        effect:
          contribution >= 0
            ? 'INCREASES_RISK'
            : 'DECREASES_RISK',
      });
    }

    const failureProbability =
      this.sigmoid(logit);

    const riskLevel =
      this.getRiskLevel(
        failureProbability,
      );

    const topSignals = signals
      .sort(
        (a, b) =>
          Math.abs(
            b.contribution,
          ) -
          Math.abs(
            a.contribution,
          ),
      )
      .slice(0, 4);

    return {
      model: {
        type:
          this.artifact.modelType,

        version:
          this.artifact.modelVersion,
      },

      predictionHorizonMinutes:
        this.artifact
          .predictionHorizonMinutes,

      failureProbability,

      failureProbabilityPercent:
        Math.round(
          failureProbability *
            10000,
        ) / 100,

      decisionThreshold:
        this.artifact
          .decisionThreshold,

      elevatedRisk:
        failureProbability >=
        this.artifact
          .decisionThreshold,

      riskLevel,

      signals: topSignals,
    };
  }

  async evaluateSegment(
    input: EvaluateSegmentDto,
  ): Promise<SegmentPredictionResult> {
    const extracted =
      await this.featuresService.extract(
        input,
      );

    if (
      !extracted.evidence
        .sufficientEvidence
    ) {
      // Poca muestra NO es riesgo. De madrugada el trafico baja de forma
      // legitima; devolver INSUFFICIENT_EVIDENCE es preferible a inventar un
      // HIGH por falta de datos.
      return {
        status:
          'INSUFFICIENT_EVIDENCE',

        segment:
          extracted.segment,

        features: null,

        evidence:
          extracted.evidence,

        failureContext:
          extracted.failureContext,

        temporal: extracted.temporal,

        featureVectorV2: null,

        yunoFailureContext:
          extracted.yunoFailureContext,

        baselineMode:
          extracted.baselineMode,

        prediction: null,
      };
    }

    // El artefacto V2 espera el vector completo; el V1 solo conoce las 8
    // features antiguas. Se elige segun lo que declare el artefacto cargado.
    const usesV2 =
      this.artifact.features.includes(
        'local_time_sin',
      );

    const prediction = usesV2
      ? this.scoreVector(
          extracted.featureVectorV2,
        )
      : this.evaluate(
          extracted.modelInput,
        );

    return {
      status: 'PREDICTION',

      segment:
        extracted.segment,

      features:
        extracted.modelInput,

      evidence:
        extracted.evidence,

      failureContext:
        extracted.failureContext,

      temporal: extracted.temporal,

      featureVectorV2:
        extracted.featureVectorV2,

      yunoFailureContext:
        extracted.yunoFailureContext,

      baselineMode:
        extracted.baselineMode,

      prediction,
    };
  }

  async scan(): Promise<PredictionScanResult> {
    const activeSegments =
      await this.featuresService
        .discoverActiveSegments();

    const results =
      await Promise.all(
        activeSegments.map(
          ({ segment }) =>
            this.evaluateSegment({
              merchant:
                segment.merchant,

              provider:
                segment.provider,

              method:
                segment.method,

              country:
                segment.country,

              issuingBank:
                segment.issuingBank,
            }),
        ),
      );

    const predictions =
      results.filter(
        (
          result,
        ): result is SegmentPredictionResult & {
          status: 'PREDICTION';

          features:
            ExtractedFeatures['modelInput'];

          prediction:
            PredictionResult;
        } =>
          result.status ===
            'PREDICTION' &&
          result.features !==
            null &&
          result.prediction !==
            null,
      );

    const watchRisks =
      predictions
        .filter(
          (result) =>
            result.prediction
              .riskLevel ===
            'WATCH',
        )
        .sort(
          (a, b) =>
            b.prediction
              .failureProbability -
            a.prediction
              .failureProbability,
        )
        .map((result) => ({
          segment:
            result.segment,

          evidence:
            result.evidence,

          features:
            result.features,

          failureContext:
            result.failureContext,

          prediction:
            result.prediction,
        }));

    const elevatedRisks =
      predictions
        .filter(
          (result) =>
            result.prediction
              .elevatedRisk,
        )
        .sort(
          (a, b) =>
            b.prediction
              .failureProbability -
            a.prediction
              .failureProbability,
        )
        .map((result) => ({
          segment:
            result.segment,

          evidence:
            result.evidence,

          features:
            result.features,

          failureContext:
            result.failureContext,

          prediction:
            result.prediction,
        }));

    return {
      scannedAt:
        new Date().toISOString(),

      evaluatedSegments:
        activeSegments.length,

      predictions:
        predictions.length,

      insufficientEvidence:
        results.length -
        predictions.length,

      watchRisks,

      elevatedRisks,
    };
  }

  private sigmoid(
    value: number,
  ): number {
    if (value >= 0) {
      return (
        1 /
        (1 + Math.exp(-value))
      );
    }

    const expValue =
      Math.exp(value);

    return (
      expValue /
      (1 + expValue)
    );
  }

  private getRiskLevel(
    probability: number,
  ): RiskLevel {
    if (
      probability >=
      this.artifact
        .decisionThreshold
    ) {
      return 'HIGH';
    }

    if (probability >= 0.1) {
      return 'WATCH';
    }

    return 'LOW';
  }

  private loadModel():
    ModelArtifact {
    const modelPath =
      resolve(
        process.cwd(),
        'ml',
        'artifacts',
        'failure_prediction_v2.json',
      );

    // V2 si existe; si no, se cae a V1 para no romper un despliegue que
    // todavia no tenga el artefacto nuevo.
    const fallbackPath =
      resolve(
        process.cwd(),
        'ml',
        'artifacts',
        'failure_prediction_v1.json',
      );

    if (
      !existsSync(modelPath) &&
      existsSync(fallbackPath)
    ) {
      return JSON.parse(
        readFileSync(fallbackPath, 'utf-8'),
      ) as ModelArtifact;
    }

    if (
      !existsSync(modelPath)
    ) {
      throw new InternalServerErrorException(
        `No se encontró el modelo ML en ${modelPath}`,
      );
    }

    try {
      const content =
        readFileSync(
          modelPath,
          'utf-8',
        );

      return JSON.parse(
        content,
      ) as ModelArtifact;
    } catch (error) {
      throw new InternalServerErrorException(
        `No fue posible cargar el modelo ML: ${
          error instanceof Error
            ? error.message
            : 'error desconocido'
        }`,
      );
    }
  }

  private validateArtifact():
    void {
    const {
      features,
      scaler,
      model,
    } = this.artifact;

    if (
      features.length !==
        scaler.mean.length ||
      features.length !==
        scaler.scale.length ||
      features.length !==
        model.coefficients.length
    ) {
      throw new InternalServerErrorException(
        'El artefacto ML tiene dimensiones inconsistentes.',
      );
    }

    if (
      !Number.isFinite(
        model.intercept,
      ) ||
      !Number.isFinite(
        this.artifact
          .decisionThreshold,
      )
    ) {
      throw new InternalServerErrorException(
        'El artefacto ML contiene parámetros inválidos.',
      );
    }

    const hasInvalidNumbers = [
      ...scaler.mean,
      ...scaler.scale,
      ...model.coefficients,
    ].some(
      (value) =>
        !Number.isFinite(value),
    );

    if (hasInvalidNumbers) {
      throw new InternalServerErrorException(
        'El artefacto ML contiene valores numéricos inválidos.',
      );
    }
  }
}