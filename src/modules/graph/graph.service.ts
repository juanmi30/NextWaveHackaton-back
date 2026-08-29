import { Injectable, NotFoundException } from '@nestjs/common';
import type { Dimension, DimensionMap } from '../../common/dimensions.js';
import { round } from '../../common/stats.js';
import { IncidentsService } from '../incidents/incidents.service.js';

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
  type: 'flow' | 'diagnostic_evidence';
};

@Injectable()
export class GraphService {
  constructor(private readonly incidents: IncidentsService) {}

  async getIncidentGraph(incidentId: string) {
    /*
     * IncidentsService.findOne() ya trae:
     *
     * - el Incident
     * - todas sus versiones de IncidentDiagnosis
     * - DiagnosisEvidence de cada diagnóstico
     */
    const incident = await this.incidents.findOne(incidentId);

    /*
     * En IncidentsRepository los diagnósticos vienen ordenados:
     *
     * version ASC
     *
     * Por eso el último es el diagnóstico más reciente.
     */
    const diagnosis = incident.diagnoses[incident.diagnoses.length - 1];

    if (!diagnosis) {
      throw new NotFoundException(
        `Incident ${incidentId} does not have a diagnosis`,
      );
    }

    const dimensions = diagnosis.dimensions as unknown as DimensionMap;

    /*
     * DiagnosisEvidence contiene las métricas individuales de las
     * dimensiones que ayudaron a explicar el incidente.
     *
     * Ej:
     *
     * provider=Adyen
     * baseline 91%
     * observed 55%
     */
    const evidenceByDimension = new Map(
      diagnosis.evidence.map((row) => [row.dimension, row]),
    );

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];

    /*
     * Nodo inicial.
     */
    nodes.push({
      id: 'traffic',
      type: 'traffic',
      data: {
        label: 'All payment traffic',
      },
    });

    let previousNodeId = 'traffic';

    /*
     * Construimos una ruta fija:
     *
     * Merchant
     * Provider
     * Method
     * Country
     * Issuing Bank
     *
     * Si una dimensión forma parte del diagnóstico:
     * scope = MATCH
     *
     * Si no:
     * scope = ANY
     */
    for (const dimension of FLOW_DIMENSIONS) {
      const value = dimensions[dimension];
      const evidence = evidenceByDimension.get(dimension);

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

          /*
           * Si está en dimensions, forma parte de la combinación
           * identificada por el detector.
           */
          isRootCauseComponent: matched,

          /*
           * Estas métricas son específicas de esta dimensión.
           * Si no hay evidencia individual disponible las dejamos null
           * en vez de inventarlas.
           */
          baselineRate: evidence?.baselineRate ?? null,
          observedRate: evidence?.observedRate ?? null,
          difference: evidence?.difference ?? null,
          attempts: evidence?.attempts ?? null,
          confidence: evidence?.confidence ?? null,
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

    /*
     * IMPORTANTE:
     *
     * La causa raíz no necesariamente es "Bradesco".
     *
     * Puede ser la INTERSECCIÓN:
     *
     * Adyen + BR + Bradesco
     *
     * Por eso creamos un nodo separado que representa la combinación.
     */
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

        baselineRate: diagnosis.baselineRate,
        observedRate: diagnosis.observedRate,

        drop: round(
          diagnosis.baselineRate - diagnosis.observedRate,
        ),

        baselineAttempts: diagnosis.baselineAttempts,
        observedAttempts: diagnosis.observedAttempts,
        confidence: diagnosis.confidence,

        lostApprovals: incident.lostApprovals,
        lossPerMinuteCents: incident.lossPerMinuteCents,
      },
    });

    edges.push({
      id: `${previousNodeId}->${rootCauseNodeId}`,
      source: previousNodeId,
      target: rootCauseNodeId,
      type: 'flow',
    });

    /*
     * failureReason NO es realmente una etapa del pago.
     *
     * Ej:
     * GATEWAY_TIMEOUT
     *
     * Es evidencia de por qué está fallando el segmento.
     *
     * Por eso sale como una rama del root cause.
     */
    if (dimensions.failureReason) {
      const evidence = evidenceByDimension.get('failureReason');

      const evidenceNodeId = 'evidence:failureReason';

      nodes.push({
        id: evidenceNodeId,
        type: 'evidence',
        data: {
          label: `Failure reason: ${dimensions.failureReason}`,
          dimension: 'failureReason',
          value: dimensions.failureReason,

          baselineRate: evidence?.baselineRate ?? null,
          observedRate: evidence?.observedRate ?? null,
          difference: evidence?.difference ?? null,
          attempts: evidence?.attempts ?? null,
          confidence: evidence?.confidence ?? null,
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
      incidentId: incident.id,
      status: incident.status,
      severity: incident.severity,

      diagnosis: {
        id: diagnosis.id,
        version: diagnosis.version,
        fingerprint: diagnosis.fingerprint,
        dimensions,
        dimensionDepth: diagnosis.dimensionDepth,

        baselineRate: diagnosis.baselineRate,
        observedRate: diagnosis.observedRate,

        drop: round(
          diagnosis.baselineRate - diagnosis.observedRate,
        ),

        confidence: diagnosis.confidence,
      },

      impact: {
        expectedApprovals: incident.expectedApprovals,
        actualApprovals: incident.actualApprovals,
        lostApprovals: incident.lostApprovals,
        averageTicketCents: incident.averageTicketCents,
        lossPerMinuteCents: incident.lossPerMinuteCents,
      },

      rootCause: {
        label: rootCauseLabel,
        dimensions,
      },

      nodes,
      edges,
    };
  }
}