import { tool } from '@openai/agents';
import { z } from 'zod';
import { IncidentsService } from '../../incidents/incidents.service.js';

export function createGetIncidentTool(incidents: IncidentsService) {
  return tool({
    name: 'get_incident',
    description:
      'Load the requested incident, its latest diagnosis, and quantitative evidence. Always call this first.',
    parameters: z.object({ incidentId: z.string().min(1) }),
    execute: async ({ incidentId }) => {
      const incident = await incidents.findOne(incidentId);
      const latestDiagnosis = incident.diagnoses.at(-1) ?? null;

      return {
        incident: {
          id: incident.id,
          status: incident.status,
          severity: incident.severity,
          expectedApprovals: incident.expectedApprovals,
          actualApprovals: incident.actualApprovals,
          lostApprovals: incident.lostApprovals,
          averageTicketCents: incident.averageTicketCents,
          lossPerMinuteCents: incident.lossPerMinuteCents,
          startedAt: incident.startedAt,
          detectedAt: incident.detectedAt,
          summaryOps: incident.summaryOps,
          summaryExec: incident.summaryExec,
          recommendation: incident.recommendation,
          confidenceStatement: incident.confidenceStatement,
        },
        diagnosisVersionCount: incident.diagnoses.length,
        latestDiagnosis: latestDiagnosis
          ? {
              dimensions: latestDiagnosis.dimensions,
              dimensionDepth: latestDiagnosis.dimensionDepth,
              baselineRate: latestDiagnosis.baselineRate,
              observedRate: latestDiagnosis.observedRate,
              baselineAttempts: latestDiagnosis.baselineAttempts,
              observedAttempts: latestDiagnosis.observedAttempts,
              confidence: latestDiagnosis.confidence,
            }
          : null,
        evidence:
          latestDiagnosis?.evidence.map((row) => ({
            dimension: row.dimension,
            dimensionValue: row.dimensionValue,
            baselineRate: row.baselineRate,
            observedRate: row.observedRate,
            difference: row.difference,
            attempts: row.attempts,
            confidence: row.confidence,
            isRootCause: row.isRootCause,
          })) ?? [],
      };
    },
  });
}
