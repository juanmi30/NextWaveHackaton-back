import { tool } from '@openai/agents';
import { z } from 'zod';
import { IncidentsService } from '../../incidents/incidents.service.js';

export function createListActiveIncidentsTool(incidents: IncidentsService) {
  return tool({
    name: 'list_active_incidents',
    description:
      'List a small, backend-ranked set of open incidents for operational context. Do not use it to replace get_incident.',
    parameters: z.object({ limit: z.number().int().min(1).max(20).default(10) }),
    execute: async ({ limit }) => {
      const active = await incidents.findAll({ status: 'OPEN', limit });
      return active.map((incident) => {
        const latestDiagnosis = incident.diagnoses[0] ?? null;
        return {
          id: incident.id,
          severity: incident.severity,
          lossPerMinuteCents: incident.lossPerMinuteCents,
          detectedAt: incident.detectedAt,
          summaryOps: incident.summaryOps,
          dimensions: latestDiagnosis?.dimensions ?? null,
          confidence: latestDiagnosis?.confidence ?? null,
        };
      });
    },
  });
}
