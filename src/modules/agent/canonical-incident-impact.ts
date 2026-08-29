import type { AgentDiagnosis } from './schemas/agent-diagnosis.schema.js';

type CanonicalIncident = {
  lossPerMinuteCents: number;
  startedAt: Date | null;
  diagnoses: Array<{
    baselineRate: number | null;
    observedRate: number | null;
  }>;
};

export function getCanonicalIncidentImpact(incident: CanonicalIncident): AgentDiagnosis['impact'] {
  const latestDiagnosis = incident.diagnoses.at(-1);

  return {
    expectedApprovalRate: latestDiagnosis?.baselineRate ?? null,
    observedApprovalRate: latestDiagnosis?.observedRate ?? null,
    lossPerMinuteCents: incident.lossPerMinuteCents,
    startedAt: incident.startedAt?.toISOString() ?? null,
  };
}

export function enforceCanonicalIncidentImpact(
  diagnosis: AgentDiagnosis,
  incident: CanonicalIncident,
): AgentDiagnosis {
  return {
    ...diagnosis,
    impact: getCanonicalIncidentImpact(incident),
  };
}
