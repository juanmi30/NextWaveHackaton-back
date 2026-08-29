import { Injectable, NotFoundException } from '@nestjs/common';

import {
  buildSegmentKey,
  type Dimension,
  type DimensionMap,
} from '../../common/dimensions.js';

import {
  approvalRate,
  confidenceFrom,
  round,
  zScore,
} from '../../common/stats.js';

import {
  BaselinesService,
  type BaselineLookup,
} from '../baselines/baselines.service.js';

import { DetectionRepository } from '../detection/detection.repository.js';
import { IncidentsService } from '../incidents/incidents.service.js';

import {
  TransactionsRepository,
  toWhere,
} from '../transactions/transactions.repository.js';

const FLOW_DIMENSIONS = [
  'merchant',
  'provider',
  'method',
  'country',
  'issuingBank',
] as const satisfies readonly Dimension[];

type FlowDimension = (typeof FLOW_DIMENSIONS)[number];

const STAGE_LABELS: Record<FlowDimension, string> = {
  merchant: 'Merchant',
  provider: 'Provider',
  method: 'Payment method',
  country: 'Country',
  issuingBank: 'Issuing bank',
};

type GraphNode = {
  id: string;
  type: 'traffic' | 'dimension' | 'rootCause' | 'evidence';
  data: Record<string, unknown>;
};

type GraphEdge = {
  id: string;
  source: string;
  target: string;
  type:
    | 'flow'
    | 'diagnostic_evidence'
    | 'selected'
    | 'alternative';
};

type ExplorerHealth =
  | 'SELECTED'
  | 'HEALTHY'
  | 'DEGRADED'
  | 'INCONCLUSIVE';

/*
 * BaselinesService normalmente devuelve uno de estos:
 *
 * segment_hour
 * segment_global
 * none
 *
 * Pero el explorer tiene un fallback adicional:
 *
 * diagnosis_evidence
 *
 * Ese fallback se usa cuando las transacciones originales ya no están
 * disponibles, pero el diagnóstico persistido sí conserva evidencia.
 */
type ExplorerBaselineSource =
  | BaselineLookup['source']
  | 'diagnosis_evidence';

type ExplorerSibling = {
  dimension: FlowDimension;
  value: string;
  segment: DimensionMap;
  segmentKey: string;

  selected: boolean;
  health: ExplorerHealth;

  attempts: number;
  approved: number;

  baselineRate: number | null;
  observedRate: number;

  deltaPp: number | null;

  drop: number;
  dropPp: number;

  zScore: number | null;
  confidence: number | null;

  baselineAttempts: number;
  baselineSource: ExplorerBaselineSource;
};

@Injectable()
export class GraphService {
  constructor(
    private readonly incidents: IncidentsService,
    private readonly transactions: TransactionsRepository,
    private readonly baselines: BaselinesService,
    private readonly detectionRuns: DetectionRepository,
  ) {}

  /*
   * ============================================================
   * V1
   * ============================================================
   *
   * Representa el flujo transaccional completo:
   *
   * Traffic
   *   ↓
   * Merchant
   *   ↓
   * Provider
   *   ↓
   * Method
   *   ↓
   * Country
   *   ↓
   * Issuing Bank
   *   ↓
   * Root Cause
   *
   * Las dimensiones que forman parte del diagnóstico aparecen
   * como MATCH.
   *
   * Las que no restringen el incidente aparecen como ANY.
   */
  async getIncidentGraph(incidentId: string) {
    const incident = await this.incidents.findOne(incidentId);

    const diagnosis =
      incident.diagnoses[incident.diagnoses.length - 1];

    if (!diagnosis) {
      throw new NotFoundException(
        `Incident ${incidentId} does not have a diagnosis`,
      );
    }

    const dimensions =
      diagnosis.dimensions as unknown as DimensionMap;

    const evidenceByDimension = new Map(
      diagnosis.evidence.map((row) => [
        row.dimension,
        row,
      ]),
    );

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];

    nodes.push({
      id: 'traffic',
      type: 'traffic',
      data: {
        label: 'All payment traffic',
      },
    });

    let previousNodeId = 'traffic';

    for (const dimension of FLOW_DIMENSIONS) {
      const value = dimensions[dimension];
      const evidence =
        evidenceByDimension.get(dimension);

      const nodeId = `dimension:${dimension}`;
      const matched = value !== undefined;

      nodes.push({
        id: nodeId,
        type: 'dimension',
        data: {
          label: matched
            ? `${STAGE_LABELS[dimension]}: ${value}`
            : `${STAGE_LABELS[dimension]}: Any`,

          dimension,
          value: value ?? null,

          scope: matched ? 'MATCH' : 'ANY',

          isRootCauseComponent: matched,

          baselineRate:
            evidence?.baselineRate ?? null,

          observedRate:
            evidence?.observedRate ?? null,

          difference:
            evidence?.difference ?? null,

          attempts:
            evidence?.attempts ?? null,

          confidence:
            evidence?.confidence ?? null,
        },
      });

      edges.push({
        id: `${previousNodeId}->${nodeId}`,
        source: previousNodeId,
        target: nodeId,
        type: 'flow',
      });

      previousNodeId = nodeId;
    }

    const rootCauseNodeId = 'root-cause';

    const rootCauseLabel =
      [
        dimensions.merchant,
        dimensions.provider,
        dimensions.method,
        dimensions.country,
        dimensions.issuingBank,
        dimensions.failureReason,
      ]
        .filter(Boolean)
        .join(' × ') || 'Affected segment';

    nodes.push({
      id: rootCauseNodeId,
      type: 'rootCause',
      data: {
        label: `Root cause: ${rootCauseLabel}`,

        dimensions,

        baselineRate:
          diagnosis.baselineRate,

        observedRate:
          diagnosis.observedRate,

        drop: round(
          diagnosis.baselineRate -
            diagnosis.observedRate,
        ),

        baselineAttempts:
          diagnosis.baselineAttempts,

        observedAttempts:
          diagnosis.observedAttempts,

        confidence:
          diagnosis.confidence,

        lostApprovals:
          incident.lostApprovals,

        lossPerMinuteCents:
          incident.lossPerMinuteCents,
      },
    });

    edges.push({
      id: `${previousNodeId}->${rootCauseNodeId}`,
      source: previousNodeId,
      target: rootCauseNodeId,
      type: 'flow',
    });

    /*
     * failureReason no es una etapa física de la ruta.
     * Se representa como evidencia que sale del root cause.
     */
    if (dimensions.failureReason) {
      const evidence =
        evidenceByDimension.get('failureReason');

      const evidenceNodeId =
        'evidence:failureReason';

      nodes.push({
        id: evidenceNodeId,
        type: 'evidence',
        data: {
          label:
            `Failure reason: ${dimensions.failureReason}`,

          dimension: 'failureReason',

          value:
            dimensions.failureReason,

          baselineRate:
            evidence?.baselineRate ?? null,

          observedRate:
            evidence?.observedRate ?? null,

          difference:
            evidence?.difference ?? null,

          attempts:
            evidence?.attempts ?? null,

          confidence:
            evidence?.confidence ?? null,
        },
      });

      edges.push({
        id: `${rootCauseNodeId}->${evidenceNodeId}`,
        source: rootCauseNodeId,
        target: evidenceNodeId,
        type: 'diagnostic_evidence',
      });
    }

    return {
      incidentId:
        incident.id,

      status:
        incident.status,

      severity:
        incident.severity,

      diagnosis: {
        id:
          diagnosis.id,

        version:
          diagnosis.version,

        fingerprint:
          diagnosis.fingerprint,

        dimensions,

        dimensionDepth:
          diagnosis.dimensionDepth,

        baselineRate:
          diagnosis.baselineRate,

        observedRate:
          diagnosis.observedRate,

        drop: round(
          diagnosis.baselineRate -
            diagnosis.observedRate,
        ),

        confidence:
          diagnosis.confidence,
      },

      impact: {
        expectedApprovals:
          incident.expectedApprovals,

        actualApprovals:
          incident.actualApprovals,

        lostApprovals:
          incident.lostApprovals,

        averageTicketCents:
          incident.averageTicketCents,

        lossPerMinuteCents:
          incident.lossPerMinuteCents,
      },

      rootCause: {
        label:
          rootCauseLabel,

        dimensions,
      },

      nodes,
      edges,
    };
  }

  /*
   * ============================================================
   * V2 - EXPLORER
   * ============================================================
   *
   * La V1 muestra únicamente la ruta final.
   *
   * La V2 muestra también las alternativas evaluadas alrededor
   * de cada paso de la ruta ganadora.
   *
   * Ejemplo:
   *
   *                       ALL TRAFFIC
   *                           |
   *              +------------+------------+
   *              |            |            |
   *         Mercado Uno   Otro merchant  Otro merchant
   *          SELECTED        HEALTHY        HEALTHY
   *              |
   *        +-----+-----+
   *        |     |     |
   *     Stripe Adyen dLocal
   *     HEALTHY SELECTED HEALTHY
   *              |
   *        +-----+------+
   *        |     |      |
   *      Itaú Bradesco Nubank
   *           SELECTED
   *              |
   *          ROOT CAUSE
   */
  async getIncidentExplorer(
    incidentId: string,
  ) {
    /*
     * 1. Recuperamos incidente y último diagnóstico.
     */
    const incident =
      await this.incidents.findOne(incidentId);

    const diagnosis =
      incident.diagnoses[
        incident.diagnoses.length - 1
      ];

    if (!diagnosis) {
      throw new NotFoundException(
        `Incident ${incidentId} does not have a diagnosis`,
      );
    }

    const dimensions =
      diagnosis.dimensions as unknown as DimensionMap;

    /*
     * Usamos específicamente el DetectionRun que generó
     * esta versión del diagnóstico.
     */
    const run =
      await this.detectionRuns.findRun(
        diagnosis.detectionRunId,
      );

    if (!run) {
      throw new NotFoundException(
        `Detection run ${diagnosis.detectionRunId} not found`,
      );
    }

    /*
     * Recuperamos exactamente los thresholds utilizados
     * en el run original.
     *
     * Si faltan, usamos los defaults actuales del detector.
     */
    const minSampleSize =
      readNumberParam(
        run.params,
        'minSampleSize',
        20,
      );

    const minZScore =
      readNumberParam(
        run.params,
        'minZScore',
        2.5,
      );

    const minConfidence =
      readNumberParam(
        run.params,
        'minConfidence',
        0.35,
      );

    const minDrop =
      readNumberParam(
        run.params,
        'minDrop',
        0.1,
      );

    /*
     * V2 solamente recorre dimensiones que efectivamente
     * forman parte de la causa raíz.
     *
     * Ej:
     *
     * merchant
     * provider
     * issuingBank
     *
     * No aparecen Method: Any ni Country: Any.
     */
    const selectedDimensions =
      FLOW_DIMENSIONS.filter(
        (dimension) =>
          dimensions[dimension] !== undefined,
      );

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];

    nodes.push({
      id: 'traffic',
      type: 'traffic',
      data: {
        label: 'All payment traffic',
      },
    });

    /*
     * Filtros que forman la rama seleccionada.
     *
     * Empieza vacío:
     *
     * {}
     *
     * después:
     *
     * { merchant: 'Mercado Uno' }
     *
     * después:
     *
     * {
     *   merchant: 'Mercado Uno',
     *   provider: 'Adyen'
     * }
     */
    let parentFilters: DimensionMap = {};

    let selectedParentNodeId =
      'traffic';

    const levels: Array<
      Record<string, unknown>
    > = [];

    /*
     * Recorremos únicamente las dimensiones del
     * diagnóstico ganador.
     */
    for (
      const dimension of selectedDimensions
    ) {
      const selectedValue =
        dimensions[dimension];

      if (selectedValue === undefined) {
        continue;
      }

      /*
       * Consultamos TODOS los valores posibles de la
       * dimensión actual dentro del parent seleccionado.
       *
       * Por ejemplo:
       *
       * provider dentro de merchant=Mercado Uno
       */
      const currentSlices =
        await this.transactions.aggregateBy(
          [dimension],
          run.windowStart,
          run.windowEnd,
          toWhere(parentFilters),
        );

      /*
       * Añadimos los filtros del padre para construir
       * el segmento completo correspondiente a cada sibling.
       */
      const slicesWithSegments =
        currentSlices.map((slice) => {
          const value =
            slice.dimensions[dimension];

          const segment: DimensionMap = {
            ...parentFilters,
            [dimension]: value,
          };

          return {
            ...slice,
            value,
            segment,
            segmentKey:
              buildSegmentKey(segment),
          };
        });

      /*
       * Obtenemos todos los baselines en una sola llamada.
       */
      const baselineIndex =
        await this.baselines.lookupMany(
          slicesWithSegments.map(
            (slice) => slice.segmentKey,
          ),
          run.windowEnd,
        );

      /*
       * Tipo EXPLÍCITO.
       *
       * Esto evita el error que tenías con baselineSource.
       */
      const siblings: ExplorerSibling[] =
        slicesWithSegments.map(
          (slice): ExplorerSibling => {
            const baseline =
              baselineIndex.get(
                slice.segmentKey,
              );

            const observedRate =
              approvalRate(
                slice.approved,
                slice.attempts,
              );

            const hasBaseline =
              baseline !== undefined &&
              baseline.source !== 'none' &&
              baseline.sampleSize >=
                minSampleSize;

            const enoughObservedSample =
              slice.attempts >=
              minSampleSize;

            const expectedRate =
              hasBaseline && baseline
                ? baseline.expectedRate
                : null;

            /*
             * Delta firmado:
             *
             * -49 = empeoró 49 puntos porcentuales
             * +1  = mejoró 1 punto porcentual
             */
            const deltaPp =
              expectedRate === null
                ? null
                : roundToTwo(
                    (
                      observedRate -
                      expectedRate
                    ) * 100,
                  );

            /*
             * drop conserva la misma semántica
             * del DetectionService:
             *
             * solo representa una caída.
             */
            const drop =
              expectedRate === null
                ? 0
                : Math.max(
                    0,
                    expectedRate -
                      observedRate,
                  );

            const z =
              hasBaseline && baseline
                ? zScore(
                    observedRate,
                    baseline.expectedRate,
                    slice.attempts,
                    baseline.variance,
                  )
                : 0;

            const confidence =
              hasBaseline
                ? confidenceFrom(
                    z,
                    slice.attempts,
                    minSampleSize,
                  )
                : 0;

            /*
             * Mismos criterios conceptuales del detector.
             */
            const degraded =
              hasBaseline &&
              enoughObservedSample &&
              drop >= minDrop &&
              z >= minZScore &&
              confidence >=
                minConfidence;

            const selected =
              slice.value ===
              selectedValue;

            let health: ExplorerHealth;

            if (selected) {
              health = 'SELECTED';
            } else if (
              !hasBaseline ||
              !enoughObservedSample
            ) {
              health =
                'INCONCLUSIVE';
            } else if (degraded) {
              health =
                'DEGRADED';
            } else {
              health =
                'HEALTHY';
            }

            return {
              dimension,

              value:
                slice.value ??
                '(sin valor)',

              segment:
                slice.segment,

              segmentKey:
                slice.segmentKey,

              selected,
              health,

              attempts:
                slice.attempts,

              approved:
                slice.approved,

              baselineRate:
                baseline &&
                hasBaseline
                  ? baseline.expectedRate
                  : null,

              observedRate:
                round(observedRate),

              deltaPp,

              drop:
                round(drop),

              dropPp:
                roundToTwo(
                  drop * 100,
                ),

              zScore:
                hasBaseline
                  ? round(z)
                  : null,

              confidence:
                hasBaseline
                  ? confidence
                  : null,

              baselineAttempts:
                baseline?.sampleSize ??
                0,

              baselineSource:
                baseline?.source ??
                'none',
            };
          },
        );

      /*
       * Nodo que corresponde al camino ganador.
       */
      const selectedSibling =
        siblings.find(
          (sibling) =>
            sibling.selected,
        );

      /*
       * Alternativas:
       *
       * primero degradadas,
       * después inconclusas,
       * después healthy.
       *
       * Dentro del mismo grupo, mostramos primero
       * las de mayor desviación.
       */
      const alternatives =
        siblings
          .filter(
            (sibling) =>
              !sibling.selected,
          )
          .sort((a, b) => {
            const healthDifference =
              explorerHealthRank(
                b.health,
              ) -
              explorerHealthRank(
                a.health,
              );

            if (
              healthDifference !== 0
            ) {
              return healthDifference;
            }

            return (
              Math.abs(
                b.deltaPp ?? 0,
              ) -
              Math.abs(
                a.deltaPp ?? 0,
              )
            );
          })
          .slice(0, 5);

      /*
       * Declaramos explícitamente ExplorerSibling[].
       *
       * Esto también es parte de la corrección del
       * error TypeScript que tenías.
       */
      let visibleSiblings:
        ExplorerSibling[] =
          selectedSibling
            ? [
                selectedSibling,
                ...alternatives,
              ]
            : [...alternatives];

      /*
       * Fallback:
       *
       * si las transacciones del DetectionRun ya no están
       * disponibles, intentamos reconstruir el nodo
       * seleccionado usando DiagnosisEvidence.
       */
      if (!selectedSibling) {
        const evidence =
          diagnosis.evidence.find(
            (row) =>
              row.dimension ===
              dimension,
          );

        const selectedSegment:
          DimensionMap = {
          ...parentFilters,
          [dimension]:
            selectedValue,
        };

        /*
         * Gracias al tipo ExplorerBaselineSource,
         * diagnosis_evidence es ahora un valor legal.
         */
        const fallbackSibling:
          ExplorerSibling = {
          dimension,

          value:
            selectedValue,

          segment:
            selectedSegment,

          segmentKey:
            buildSegmentKey(
              selectedSegment,
            ),

          selected: true,

          health:
            'SELECTED',

          attempts:
            evidence?.attempts ?? 0,

          approved: 0,

          baselineRate:
            evidence?.baselineRate ??
            null,

          observedRate:
            evidence?.observedRate ??
            0,

          deltaPp:
            evidence
              ? roundToTwo(
                  (
                    evidence.observedRate -
                    evidence.baselineRate
                  ) * 100,
                )
              : null,

          drop:
            evidence?.difference ?? 0,

          dropPp:
            evidence
              ? roundToTwo(
                  evidence.difference *
                    100,
                )
              : 0,

          zScore: null,

          confidence:
            evidence?.confidence ??
            null,

          baselineAttempts: 0,

          /*
           * ESTE ERA EL VALOR QUE CAUSABA EL ERROR.
           *
           * Ahora el tipo ExplorerBaselineSource
           * lo acepta correctamente.
           */
          baselineSource:
            'diagnosis_evidence',
        };

        visibleSiblings = [
          fallbackSibling,
          ...alternatives,
        ];
      }

      /*
       * Convertimos siblings en nodes + edges.
       */
      let nextSelectedNodeId:
        string | null = null;

      for (
        const sibling of visibleSiblings
      ) {
        const nodeId =
          explorerNodeId(
            sibling.segment,
          );

        nodes.push({
          id: nodeId,
          type: 'dimension',
          data: {
            label:
              `${STAGE_LABELS[dimension]}: ${sibling.value}`,

            dimension,

            value:
              sibling.value,

            selected:
              sibling.selected,

            health:
              sibling.health,

            segment:
              sibling.segment,

            baselineRate:
              sibling.baselineRate,

            observedRate:
              sibling.observedRate,

            deltaPp:
              sibling.deltaPp,

            drop:
              sibling.drop,

            dropPp:
              sibling.dropPp,

            attempts:
              sibling.attempts,

            confidence:
              sibling.confidence,

            zScore:
              sibling.zScore,

            baselineAttempts:
              sibling.baselineAttempts,

            baselineSource:
              sibling.baselineSource,
          },
        });

        edges.push({
          id:
            `${selectedParentNodeId}->${nodeId}`,

          source:
            selectedParentNodeId,

          target:
            nodeId,

          type:
            sibling.selected
              ? 'selected'
              : 'alternative',
        });

        if (sibling.selected) {
          nextSelectedNodeId =
            nodeId;
        }
      }

      /*
       * Metadata útil para front y debugging.
       */
      levels.push({
        dimension,

        selectedValue,

        parentFilters: {
          ...parentFilters,
        },

        totalSiblings:
          siblings.length,

        returnedSiblings:
          visibleSiblings.length,

        alternativesTruncated:
          Math.max(
            0,
            siblings.length -
              visibleSiblings.length,
          ),
      });

      /*
       * El siguiente nivel parte únicamente
       * del nodo seleccionado.
       */
      if (nextSelectedNodeId) {
        selectedParentNodeId =
          nextSelectedNodeId;
      }

      parentFilters = {
        ...parentFilters,
        [dimension]:
          selectedValue,
      };
    }

    /*
     * Nodo final de causa raíz.
     */
    const rootCauseLabel =
      [
        dimensions.merchant,
        dimensions.provider,
        dimensions.method,
        dimensions.country,
        dimensions.issuingBank,
        dimensions.failureReason,
      ]
        .filter(Boolean)
        .join(' × ') ||
      'Affected segment';

    const rootCauseNodeId =
      'root-cause';

    nodes.push({
      id: rootCauseNodeId,
      type: 'rootCause',
      data: {
        label:
          `Root cause: ${rootCauseLabel}`,

        dimensions,

        baselineRate:
          diagnosis.baselineRate,

        observedRate:
          diagnosis.observedRate,

        deltaPp:
          roundToTwo(
            (
              diagnosis.observedRate -
              diagnosis.baselineRate
            ) * 100,
          ),

        drop:
          round(
            diagnosis.baselineRate -
              diagnosis.observedRate,
          ),

        dropPp:
          roundToTwo(
            (
              diagnosis.baselineRate -
              diagnosis.observedRate
            ) * 100,
          ),

        baselineAttempts:
          diagnosis.baselineAttempts,

        observedAttempts:
          diagnosis.observedAttempts,

        confidence:
          diagnosis.confidence,

        lostApprovals:
          incident.lostApprovals,

        lossPerMinuteCents:
          incident.lossPerMinuteCents,
      },
    });

    edges.push({
      id:
        `${selectedParentNodeId}->${rootCauseNodeId}`,

      source:
        selectedParentNodeId,

      target:
        rootCauseNodeId,

      type:
        'selected',
    });

    /*
     * failureReason sigue siendo evidencia,
     * no una etapa física del flujo.
     */
    if (dimensions.failureReason) {
      const evidence =
        diagnosis.evidence.find(
          (row) =>
            row.dimension ===
            'failureReason',
        );

      const evidenceNodeId =
        'evidence:failureReason';

      nodes.push({
        id:
          evidenceNodeId,

        type:
          'evidence',

        data: {
          label:
            `Failure reason: ${dimensions.failureReason}`,

          dimension:
            'failureReason',

          value:
            dimensions.failureReason,

          baselineRate:
            evidence?.baselineRate ??
            null,

          observedRate:
            evidence?.observedRate ??
            null,

          difference:
            evidence?.difference ??
            null,

          attempts:
            evidence?.attempts ??
            null,

          confidence:
            evidence?.confidence ??
            null,
        },
      });

      edges.push({
        id:
          `${rootCauseNodeId}->${evidenceNodeId}`,

        source:
          rootCauseNodeId,

        target:
          evidenceNodeId,

        type:
          'diagnostic_evidence',
      });
    }

    return {
      mode:
        'explorer',

      incidentId:
        incident.id,

      status:
        incident.status,

      severity:
        incident.severity,

      detectionRun: {
        id:
          run.id,

        window: {
          from:
            run.windowStart,

          to:
            run.windowEnd,
        },

        thresholds: {
          minSampleSize,
          minZScore,
          minConfidence,
          minDrop,
        },
      },

      diagnosis: {
        id:
          diagnosis.id,

        version:
          diagnosis.version,

        fingerprint:
          diagnosis.fingerprint,

        dimensions,

        dimensionDepth:
          diagnosis.dimensionDepth,

        baselineRate:
          diagnosis.baselineRate,

        observedRate:
          diagnosis.observedRate,

        confidence:
          diagnosis.confidence,
      },

      rootCause: {
        label:
          rootCauseLabel,

        dimensions,
      },

      explorationOrder:
        selectedDimensions,

      levels,

      nodes,
      edges,
    };
  }
}

/*
 * Lee un parámetro numérico del JSON params almacenado
 * en DetectionRun.
 */
function readNumberParam(
  params: unknown,
  key: string,
  fallback: number,
): number {
  if (
    params === null ||
    typeof params !== 'object' ||
    Array.isArray(params)
  ) {
    return fallback;
  }

  const value =
    (
      params as Record<
        string,
        unknown
      >
    )[key];

  return (
    typeof value === 'number' &&
    Number.isFinite(value)
  )
    ? value
    : fallback;
}

/*
 * ID determinístico para cada segmento del explorer.
 */
function explorerNodeId(
  segment: DimensionMap,
): string {
  return `segment:${encodeURIComponent(
    buildSegmentKey(segment),
  )}`;
}

/*
 * Orden utilizado para decidir qué alternativas mostrar primero.
 */
function explorerHealthRank(
  health: ExplorerHealth,
): number {
  switch (health) {
    case 'SELECTED':
      return 4;

    case 'DEGRADED':
      return 3;

    case 'INCONCLUSIVE':
      return 2;

    case 'HEALTHY':
      return 1;
  }
}

/*
 * Redondeo explícito a dos decimales.
 *
 * Lo uso para puntos porcentuales para no depender
 * de la firma de round() del proyecto.
 */
function roundToTwo(
  value: number,
): number {
  return (
    Math.round(
      (value + Number.EPSILON) *
        100,
    ) / 100
  );
}