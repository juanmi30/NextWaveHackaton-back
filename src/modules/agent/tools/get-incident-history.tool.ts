import { tool } from '@openai/agents';
import { z } from 'zod';
import { IncidentsService } from '../../incidents/incidents.service.js';

export function createGetIncidentHistoryTool(incidents: IncidentsService) {
  return tool({
    name: 'get_incident_history',
    description:
      'Load resolved incidents with the same stable anchor to determine whether the current incident is a recurrence.',
    parameters: z.object({ incidentId: z.string().min(1) }),
    execute: async ({ incidentId }) => {
      const history = await incidents.history(incidentId);
      return {
        anchorFingerprint: history.anchorFingerprint,
        isRecurrence: history.isRecurrence,
        previousOccurrences: history.previousOccurrences.map((incident) => ({
          id: incident.id,
          detectedAt: incident.detectedAt,
          resolvedAt: incident.resolvedAt,
          severity: incident.severity,
          lossPerMinuteCents: incident.lossPerMinuteCents,
          summaryOps: incident.summaryOps,
          recommendation: incident.recommendation,
        })),
      };
    },
  });
}
