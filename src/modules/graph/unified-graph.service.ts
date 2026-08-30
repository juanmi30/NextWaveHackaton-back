import { Injectable } from '@nestjs/common';

import {
  buildSegmentKey,
  type DimensionMap,
} from '../../common/dimensions.js';

import { IncidentsService } from '../incidents/incidents.service.js';

import {
  PredictionFeaturesService,
} from '../prediction/prediction-features.service.js';

import {
  PredictionService,
  type RiskLevel,
  type SegmentPredictionResult,
} from '../prediction/prediction.service.js';

const FLOW_DIMENSIONS = [
  'merchant',
  'provider',
  'method',
  'country',
  'issuingBank',
] as const;

type FlowDimension =
  (typeof FLOW_DIMENSIONS)[number];

type OperationalState =
  | 'INCIDENT'
  | 'HIGH_RISK'
  | 'WATCH'
  | 'LOW_RISK'
  | 'INCONCLUSIVE';

type UnifiedNode = {
  id: string;
  type: 'traffic' | 'dimension' | 'routeStatus';
  data: Record<string, unknown>;
};

type UnifiedEdge = {
  id: string;
  source: string;
  target: string;
  type: 'selected' | 'alternative';
};

type ActiveRouteEvaluation = {
  segment: DimensionMap;
  attempts: number;
  result: SegmentPredictionResult;
};

type IncidentListItem = Awaited<
  ReturnType<IncidentsService['findAll']>
>[number];

type IncidentDetail = Awaited<
  ReturnType<IncidentsService['findOne']>
>;

type UnifiedIncident = {
  id: string;
  status: string;
  severity: number;

  priorityScore: number | null;
  priorityRank: number | null;

  lossPerMinuteCents: number;
  lostApprovals: number;

  summaryOps: string | null;
  recommendation: string | null;

  dimensions: DimensionMap;

  baselineRate: number | null;
  observedRate: number | null;

  dropPp: number | null;
  confidence: number | null;
};

@Injectable()
export class UnifiedGraphService {
  constructor(
    private readonly prediction: PredictionService,
    private readonly predictionFeatures: PredictionFeaturesService,
    private readonly incidents: IncidentsService,
  ) {}

  async build(
    options: {
      incidentId?: string;
    } = {},
  ) {
    /*
     * Obtenemos simultáneamente:
     *
     * - rutas activas descubiertas por el predictor;
     * - incidentes activos;
     * - incidente específico, si el front pidió uno.
     */
    const [
      activeSegments,
      openIncidents,
      acknowledgedIncidents,
      focusIncident,
    ] = await Promise.all([
      this.predictionFeatures
        .discoverActiveSegments(),

      this.incidents.findAll({
        status: 'OPEN',
        limit: 200,
      }),

      this.incidents.findAll({
        status: 'ACKNOWLEDGED',
        limit: 200,
      }),

      options.incidentId
        ? this.incidents.findOne(
            options.incidentId,
          )
        : Promise.resolve(null),
    ]);

    /*
     * Cache:
     *
     * evitamos evaluar dos veces el mismo
     * segmento con el modelo.
     */
    const predictionCache =
      new Map<
        string,
        SegmentPredictionResult
      >();

    /*
     * Evaluamos todas las rutas activas completas.
     *
     * Esto nos permite encontrar cuál tiene
     * mayor probabilidad de fallo.
     */
    const activeRouteEvaluations:
      ActiveRouteEvaluation[] =
      await Promise.all(
        activeSegments.map(
          async ({
            segment,
            attempts,
          }) => {
            const result =
              await this.prediction
                .evaluateSegment(
                  toEvaluateSegment(
                    segment,
                  ),
                );

            predictionCache.set(
              buildSegmentKey(
                segment,
              ),
              result,
            );

            return {
              segment,
              attempts,
              result,
            };
          },
        ),
      );

    /*
     * Convertimos incidentes a una estructura
     * más pequeña y específica para el grafo.
     */
    const incidentOverlays = [
      ...openIncidents,
      ...acknowledgedIncidents,
    ].map(
      toUnifiedIncidentFromList,
    );

    const focusIncidentOverlay =
      focusIncident
        ? toUnifiedIncidentFromDetail(
            focusIncident,
          )
        : null;

    /*
     * Si alguien consulta un incidente RESOLVED,
     * igualmente lo dejamos disponible como contexto.
     */
    if (
      focusIncidentOverlay &&
      !incidentOverlays.some(
        (incident) =>
          incident.id ===
          focusIncidentOverlay.id,
      )
    ) {
      incidentOverlays.push(
        focusIncidentOverlay,
      );
    }

    /*
     * Decidimos cuál será el camino central
     * del grafo.
     *
     * Si hay incidentId:
     *   el incidente define el scope.
     *
     * Si no:
     *   el predictor elige la ruta con
     *   mayor failureProbability.
     */
    const selected =
      this.selectFocus(
        activeRouteEvaluations,
        focusIncidentOverlay,
      );

    const nodes: UnifiedNode[] = [
      {
        id: 'traffic',

        type: 'traffic',

        data: {
          label:
            'All active payment traffic',

          activeRoutes:
            activeSegments.length,

          activeIncidents:
            incidentOverlays.filter(
              (incident) =>
                incident.status ===
                  'OPEN' ||
                incident.status ===
                  'ACKNOWLEDGED',
            ).length,
        },
      },
    ];

    const edges: UnifiedEdge[] =
      [];

    const levels:
      Array<
        Record<
          string,
          unknown
        >
      > = [];

    /*
     * No hay tráfico activo.
     */
    if (!selected) {
      return {
        mode: 'unified',

        generatedAt:
          new Date()
            .toISOString(),

        focus: null,

        summary:
          buildSummary(
            activeRouteEvaluations,
            incidentOverlays,
          ),

        levels,
        nodes,
        edges,
      };
    }

    const selectedSegment =
      selected.segment;

    const selectedDimensions =
      FLOW_DIMENSIONS.filter(
        (dimension) =>
          selectedSegment[
            dimension
          ] !== undefined,
      );

    let parentFilters:
      DimensionMap = {};

    let selectedParentNodeId =
      'traffic';

    /*
     * ===================================================
     * CONSTRUCCIÓN DEL ÁRBOL
     * ===================================================
     *
     * Recorremos:
     *
     * Merchant
     * Provider
     * Method
     * Country
     * Issuing Bank
     *
     * y evaluamos cada sibling usando EL MISMO
     * PredictionService del modelo real.
     */
    for (
      const dimension
      of selectedDimensions
    ) {
      const selectedValue =
        selectedSegment[
          dimension
        ];

      if (!selectedValue) {
        continue;
      }

      /*
       * Obtenemos los valores alternativos
       * existentes bajo el parent actual.
       *
       * Ej:
       *
       * merchant=Mercado Uno
       *
       * providers:
       * Adyen
       * Stripe
       * dLocal
       */
      const siblingValues =
        uniqueValues(
          activeSegments
            .filter(
              ({ segment }) =>
                segmentMatchesConstraints(
                  segment,
                  parentFilters,
                ),
            )
            .map(
              ({ segment }) =>
                segment[
                  dimension
                ],
            )
            .filter(
              (
                value,
              ): value is string =>
                value !==
                  undefined &&
                value !==
                  '(sin valor)',
            ),
        );

      /*
       * Si el path viene de un incidente histórico
       * puede que esa combinación ya no esté activa.
       *
       * Igualmente conservamos el nodo.
       */
      if (
        !siblingValues
          .includes(
            selectedValue,
          )
      ) {
        siblingValues.push(
          selectedValue,
        );
      }

      /*
       * Cada sibling recibe SU PROPIA
       * predicción del modelo.
       */
      const siblings =
        await Promise.all(
          siblingValues.map(
            async (value) => {
              const segment:
                DimensionMap = {
                ...parentFilters,

                [dimension]:
                  value,
              };

              const result =
                await this
                  .evaluateCached(
                    segment,
                    predictionCache,
                  );

              /*
               * Incidentes que afectan a esta rama.
               */
              const matchingIncidents =
                incidentOverlays.filter(
                  (incident) =>
                    incidentTouchesSegment(
                      segment,
                      incident.dimensions,
                    ),
                );

              const selectedNode =
                value ===
                selectedValue;

              /*
               * INCIDENT tiene prioridad visual.
               *
               * Después:
               *
               * HIGH
               * WATCH
               * LOW
               * INCONCLUSIVE
               */
              const operationalState =
                getOperationalState(
                  result,
                  matchingIncidents,
                );

              return {
                dimension,
                value,

                segment,

                selected:
                  selectedNode,

                result,

                matchingIncidents,

                operationalState,
              };
            },
          ),
        );

      const selectedSibling =
        siblings.find(
          (sibling) =>
            sibling.selected,
        );

      /*
       * Ordenamos alternativas:
       *
       * incident > high > watch >
       * inconclusive > low.
       *
       * Dentro del mismo estado:
       * mayor probabilidad primero.
       */
      const alternatives =
        siblings
          .filter(
            (sibling) =>
              !sibling.selected,
          )
          .sort(
            (
              left,
              right,
            ) =>
              stateRank(
                right
                  .operationalState,
              ) -
                stateRank(
                  left
                    .operationalState,
                ) ||
              predictionProbability(
                right.result,
              ) -
                predictionProbability(
                  left.result,
                ),
          )
          .slice(0, 5);

      const visibleSiblings =
        selectedSibling
          ? [
              selectedSibling,
              ...alternatives,
            ]
          : alternatives;

      let nextSelectedNodeId:
        string | null =
        null;

      for (
        const sibling
        of visibleSiblings
      ) {
        const nodeId =
          nodeIdForSegment(
            sibling.segment,
          );

        const predictionData =
          predictionPayload(
            sibling.result,
          );

        nodes.push({
          id: nodeId,

          type:
            'dimension',

          data: {
            label:
              `${stageLabel(
                dimension,
              )}: ${sibling.value}`,

            dimension,

            value:
              sibling.value,

            segment:
              sibling.segment,

            selected:
              sibling.selected,

            operationalState:
              sibling
                .operationalState,

            /*
             * =============================
             * PREDICTIVE DATA
             * =============================
             */
            predictionStatus:
              sibling.result
                .status,

            ...predictionData,

            /*
             * =============================
             * ACTUAL INCIDENT DATA
             * =============================
             */
            incidents:
              sibling
                .matchingIncidents,

            hasActiveIncident:
              sibling
                .matchingIncidents
                .some(
                  (incident) =>
                    incident.status ===
                      'OPEN' ||
                    incident.status ===
                      'ACKNOWLEDGED',
                ),
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

        if (
          sibling.selected
        ) {
          nextSelectedNodeId =
            nodeId;
        }
      }

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
              visibleSiblings
                .length,
          ),
      });

      if (
        nextSelectedNodeId
      ) {
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
     * ===================================================
     * ESTADO FINAL DE LA RUTA
     * ===================================================
     */

    const selectedRoutePrediction =
      await this.evaluateCached(
        selectedSegment,
        predictionCache,
      );

    const selectedRouteIncidents =
      incidentOverlays.filter(
        (incident) =>
          incidentTouchesSegment(
            selectedSegment,
            incident.dimensions,
          ),
      );

    const routeState =
      getOperationalState(
        selectedRoutePrediction,
        selectedRouteIncidents,
      );

    nodes.push({
      id: 'route-status',

      type: 'routeStatus',

      data: {
        label:
          focusIncidentOverlay !==
          null
            ? 'Observed incident + predictive risk'

            : selected.source ===
                'HIGHEST_PREDICTED_RISK'

              ? 'Highest predictive-risk active route'

              : 'Most active route — prediction inconclusive',

        segment:
          selectedSegment,

        operationalState:
          routeState,

        predictionStatus:
          selectedRoutePrediction
            .status,

        /*
         * Predictor completo:
         *
         * probability
         * riskLevel
         * features
         * signals
         * evidence
         * failureContext
         */
        ...predictionPayload(
          selectedRoutePrediction,
        ),

        /*
         * Incidentes reales que
         * afectan esta ruta.
         */
        incidents:
          selectedRouteIncidents,

        focusIncident:
          focusIncidentOverlay,
      },
    });

    edges.push({
      id:
        `${selectedParentNodeId}->route-status`,

      source:
        selectedParentNodeId,

      target:
        'route-status',

      type:
        'selected',
    });

    /*
     * ===================================================
     * RESPONSE
     * ===================================================
     */

    return {
      mode:
        'unified',

      generatedAt:
        new Date()
          .toISOString(),

      focus: {
        source:
          focusIncidentOverlay !==
          null
            ? 'INCIDENT'

            : selected.source ===
                'HIGHEST_PREDICTED_RISK'

              ? 'PREDICTION'

              : 'TRAFFIC',

        requestedIncidentId:
          options.incidentId ??
          null,

        /*
         * Root cause confirmado por
         * el detector.
         */
        incidentScope:
          focusIncidentOverlay
            ?.dimensions ??
          null,

        /*
         * Flujo completo escogido
         * para visualizar.
         */
        selectedFlow:
          selectedSegment,

        selectedFlowSource:
          selected.source,

        selectedFlowAttempts:
          selected.attempts,
      },

      summary:
        buildSummary(
          activeRouteEvaluations,
          incidentOverlays,
        ),

      explorationOrder:
        selectedDimensions,

      levels,

      nodes,

      edges,
    };
  }

  /*
   * Reutiliza una predicción ya calculada
   * cuando el mismo segmento aparece otra vez.
   */
  private async evaluateCached(
    segment: DimensionMap,

    cache:
      Map<
        string,
        SegmentPredictionResult
      >,
  ) {
    const key =
      buildSegmentKey(
        segment,
      );

    const cached =
      cache.get(key);

    if (cached) {
      return cached;
    }

    const result =
      await this.prediction
        .evaluateSegment(
          toEvaluateSegment(
            segment,
          ),
        );

    cache.set(
      key,
      result,
    );

    return result;
  }

  /*
   * Escoge el camino central del grafo.
   */
  private selectFocus(
    routes:
      ActiveRouteEvaluation[],

    focusIncident:
      UnifiedIncident |
      null,
  ):
    | {
        segment:
          DimensionMap;

        attempts:
          number;

        source:
          | 'ACTIVE_ROUTE_WITHIN_INCIDENT'
          | 'INCIDENT_SCOPE'
          | 'HIGHEST_PREDICTED_RISK'
          | 'MOST_ACTIVE_ROUTE';
      }
    | null {
    /*
     * Si el usuario abrió un incidente,
     * el incidente manda.
     */
    if (focusIncident) {
      /*
       * Buscamos rutas completas que
       * estén dentro del scope del incidente.
       *
       * Ej:
       *
       * Incident:
       * Mercado Uno + Adyen + CARD
       *
       * Active routes:
       *
       * Mercado Uno + Adyen + CARD + BR + Itaú
       * Mercado Uno + Adyen + CARD + BR + Nubank
       *
       * Tomamos la de mayor riesgo predictivo.
       */
      const matchingRoutes =
        routes
          .filter(
            (route) =>
              segmentMatchesConstraints(
                route.segment,
                focusIncident
                  .dimensions,
              ),
          )
          .sort(
            compareRouteRisk,
          );

      const bestMatch =
        matchingRoutes[0];

      if (bestMatch) {
        return {
          segment:
            bestMatch.segment,

          attempts:
            bestMatch.attempts,

          source:
            'ACTIVE_ROUTE_WITHIN_INCIDENT',
        };
      }

      /*
       * Si ya no hay tráfico actual
       * en esa ruta, seguimos mostrando
       * el scope confirmado por detector.
       */
      return {
        segment:
          focusIncident
            .dimensions,

        attempts: 0,

        source:
          'INCIDENT_SCOPE',
      };
    }

    /*
     * Sin incidentId:
     *
     * seleccionamos la ruta con
     * mayor failureProbability.
     */
    const predictedRoutes =
      routes
        .filter(
          (route) =>
            route.result
              .prediction !==
            null,
        )
        .sort(
          compareRouteRisk,
        );

    const bestPredicted =
      predictedRoutes[0];

    if (bestPredicted) {
      return {
        segment:
          bestPredicted.segment,

        attempts:
          bestPredicted.attempts,

        source:
          'HIGHEST_PREDICTED_RISK',
      };
    }

    /*
     * Si ninguna ruta tiene evidencia
     * suficiente, NO inventamos riesgo.
     *
     * Mostramos la más activa como
     * INCONCLUSIVE.
     */
    const mostActive =
      [...routes]
        .sort(
          (
            left,
            right,
          ) =>
            right.attempts -
            left.attempts,
        )[0];

    if (!mostActive) {
      return null;
    }

    return {
      segment:
        mostActive.segment,

      attempts:
        mostActive.attempts,

      source:
        'MOST_ACTIVE_ROUTE',
    };
  }
}

/*
 * =============================================================
 * HELPERS
 * =============================================================
 */

function toEvaluateSegment(
  segment: DimensionMap,
) {
  return {
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
  };
}

function compareRouteRisk(
  left:
    ActiveRouteEvaluation,

  right:
    ActiveRouteEvaluation,
) {
  const probabilityDifference =
    predictionProbability(
      right.result,
    ) -
    predictionProbability(
      left.result,
    );

  if (
    probabilityDifference !==
    0
  ) {
    return probabilityDifference;
  }

  return (
    right.attempts -
    left.attempts
  );
}

function predictionProbability(
  result:
    SegmentPredictionResult,
) {
  return (
    result.prediction
      ?.failureProbability ??
    -1
  );
}

/*
 * Normaliza todo el output del modelo
 * para enviarlo al frontend.
 */
function predictionPayload(
  result:
    SegmentPredictionResult,
) {
  if (
    result.status ===
      'INSUFFICIENT_EVIDENCE' ||
    result.prediction ===
      null
  ) {
    return {
      riskLevel:
        null,

      failureProbability:
        null,

      failureProbabilityPercent:
        null,

      elevatedRisk:
        false,

      predictionHorizonMinutes:
        null,

      decisionThreshold:
        null,

      model:
        null,

      features:
        null,

      signals:
        [],

      evidence:
        result.evidence,

      failureContext:
        result.failureContext,

      approvalDropPp:
        null,
    };
  }

  return {
    riskLevel:
      result.prediction
        .riskLevel,

    failureProbability:
      result.prediction
        .failureProbability,

    failureProbabilityPercent:
      result.prediction
        .failureProbabilityPercent,

    elevatedRisk:
      result.prediction
        .elevatedRisk,

    predictionHorizonMinutes:
      result.prediction
        .predictionHorizonMinutes,

    decisionThreshold:
      result.prediction
        .decisionThreshold,

    model:
      result.prediction
        .model,

    /*
     * Las ocho features del modelo.
     */
    features:
      result.features,

    /*
     * Las top-4 contribuciones
     * calculadas por PredictionService.
     */
    signals:
      result.prediction
        .signals,

    evidence:
      result.evidence,

    failureContext:
      result.failureContext,

    /*
     * Feature approvalDrop convertida
     * a puntos porcentuales.
     */
    approvalDropPp:
      result.features ===
      null
        ? null
        : roundToTwo(
            result.features
              .approvalDrop *
              100,
          ),
  };
}

/*
 * Un incidente confirmado SIEMPRE
 * domina el estado visual.
 */
function getOperationalState(
  prediction:
    SegmentPredictionResult,

  incidents:
    UnifiedIncident[],
): OperationalState {
  if (
    incidents.some(
      (incident) =>
        incident.status ===
          'OPEN' ||
        incident.status ===
          'ACKNOWLEDGED',
    )
  ) {
    return 'INCIDENT';
  }

  if (
    prediction.status ===
      'INSUFFICIENT_EVIDENCE' ||
    prediction.prediction ===
      null
  ) {
    return 'INCONCLUSIVE';
  }

  return riskLevelToState(
    prediction.prediction
      .riskLevel,
  );
}

function riskLevelToState(
  riskLevel:
    RiskLevel,
): OperationalState {
  switch (
    riskLevel
  ) {
    case 'HIGH':
      return 'HIGH_RISK';

    case 'WATCH':
      return 'WATCH';

    case 'LOW':
      return 'LOW_RISK';
  }
}

function stateRank(
  state:
    OperationalState,
) {
  switch (
    state
  ) {
    case 'INCIDENT':
      return 5;

    case 'HIGH_RISK':
      return 4;

    case 'WATCH':
      return 3;

    case 'INCONCLUSIVE':
      return 2;

    case 'LOW_RISK':
      return 1;
  }
}

/*
 * ¿La ruta completa cumple las restricciones?
 */
function segmentMatchesConstraints(
  segment:
    DimensionMap,

  constraints:
    DimensionMap,
) {
  return FLOW_DIMENSIONS.every(
    (dimension) => {
      const expected =
        constraints[
          dimension
        ];

      return (
        expected ===
          undefined ||
        segment[
          dimension
        ] ===
          expected
      );
    },
  );
}

/*
 * Decide si un incidente afecta a un nodo.
 *
 * Si existe una dimensión compartida
 * con valor diferente, NO lo afecta.
 */
function incidentTouchesSegment(
  segment:
    DimensionMap,

  incidentDimensions:
    DimensionMap,
) {
  let overlap =
    false;

  for (
    const dimension
    of FLOW_DIMENSIONS
  ) {
    const segmentValue =
      segment[
        dimension
      ];

    const incidentValue =
      incidentDimensions[
        dimension
      ];

    if (
      segmentValue !==
        undefined &&
      incidentValue !==
        undefined
    ) {
      overlap =
        true;

      if (
        segmentValue !==
        incidentValue
      ) {
        return false;
      }
    }
  }

  return overlap;
}

function nodeIdForSegment(
  segment:
    DimensionMap,
) {
  return (
    `segment:${encodeURIComponent(
      buildSegmentKey(
        segment,
      ),
    )}`
  );
}

function uniqueValues(
  values:
    string[],
) {
  return [
    ...new Set(
      values,
    ),
  ];
}

function stageLabel(
  dimension:
    FlowDimension,
) {
  switch (
    dimension
  ) {
    case 'merchant':
      return 'Merchant';

    case 'provider':
      return 'Provider';

    case 'method':
      return 'Payment method';

    case 'country':
      return 'Country';

    case 'issuingBank':
      return 'Issuing bank';
  }
}

/*
 * Incident obtenido desde findAll().
 */
function toUnifiedIncidentFromList(
  incident:
    IncidentListItem,
): UnifiedIncident {
  const diagnosis =
    incident
      .diagnoses[0];

  return {
    id:
      incident.id,

    status:
      incident.status,

    severity:
      incident.severity,

    priorityScore:
      incident
        .priorityScore,

    priorityRank:
      incident
        .priorityRank,

    lossPerMinuteCents:
      incident
        .lossPerMinuteCents,

    lostApprovals:
      incident
        .lostApprovals,

    summaryOps:
      incident
        .summaryOps,

    recommendation:
      incident
        .recommendation,

    dimensions:
      (
        diagnosis
          ?.dimensions as
          | DimensionMap
          | undefined
      ) ?? {},

    baselineRate:
      diagnosis
        ?.baselineRate ??
      null,

    observedRate:
      diagnosis
        ?.observedRate ??
      null,

    dropPp:
      diagnosis ===
      undefined
        ? null

        : roundToTwo(
            (
              diagnosis
                .baselineRate -
              diagnosis
                .observedRate
            ) *
              100,
          ),

    confidence:
      diagnosis
        ?.confidence ??
      null,
  };
}

/*
 * Incident obtenido desde findOne().
 */
function toUnifiedIncidentFromDetail(
  incident:
    IncidentDetail,
): UnifiedIncident {
  const diagnosis =
    incident.diagnoses[
      incident.diagnoses
        .length - 1
    ];

  return {
    id:
      incident.id,

    status:
      incident.status,

    severity:
      incident.severity,

    priorityScore:
      null,

    priorityRank:
      null,

    lossPerMinuteCents:
      incident
        .lossPerMinuteCents,

    lostApprovals:
      incident
        .lostApprovals,

    summaryOps:
      incident
        .summaryOps,

    recommendation:
      incident
        .recommendation,

    dimensions:
      (
        diagnosis
          ?.dimensions as
          | DimensionMap
          | undefined
      ) ?? {},

    baselineRate:
      diagnosis
        ?.baselineRate ??
      null,

    observedRate:
      diagnosis
        ?.observedRate ??
      null,

    dropPp:
      diagnosis ===
      undefined
        ? null

        : roundToTwo(
            (
              diagnosis
                .baselineRate -
              diagnosis
                .observedRate
            ) *
              100,
          ),

    confidence:
      diagnosis
        ?.confidence ??
      null,
  };
}

function buildSummary(
  routes:
    ActiveRouteEvaluation[],

  incidents:
    UnifiedIncident[],
) {
  let predictions =
    0;

  let insufficientEvidence =
    0;

  let highRisk =
    0;

  let watch =
    0;

  let lowRisk =
    0;

  for (
    const route
    of routes
  ) {
    if (
      route.result
        .status ===
        'INSUFFICIENT_EVIDENCE' ||
      route.result
        .prediction ===
        null
    ) {
      insufficientEvidence +=
        1;

      continue;
    }

    predictions +=
      1;

    switch (
      route.result
        .prediction
        .riskLevel
    ) {
      case 'HIGH':
        highRisk +=
          1;
        break;

      case 'WATCH':
        watch +=
          1;
        break;

      case 'LOW':
        lowRisk +=
          1;
        break;
    }
  }

  return {
    activeRoutes:
      routes.length,

    predictions,

    insufficientEvidence,

    highRiskRoutes:
      highRisk,

    watchRoutes:
      watch,

    lowRiskRoutes:
      lowRisk,

    activeIncidents:
      incidents.filter(
        (incident) =>
          incident.status ===
            'OPEN' ||
          incident.status ===
            'ACKNOWLEDGED',
      ).length,
  };
}

function roundToTwo(
  value: number,
) {
  return (
    Math.round(
      (
        value +
        Number.EPSILON
      ) *
        100,
    ) /
    100
  );
}