import { z } from 'zod';
import { EnrichedAgentDiagnosisSchema } from './agent-diagnosis.schema.js';

export const MultiIncidentAnalysisSchema = z.object({
  generatedAt: z.string(),
  portfolio: z.object({
    activeIncidentCount: z.number().int().min(0),
    successfullyAnalyzed: z.number().int().min(0),
    failedAnalyses: z.number().int().min(0),
    totalLossPerMinuteCents: z.number().int().min(0),
    highestPriorityIncidentId: z.string().nullable(),
  }),
  incidents: z.array(
    z.object({
      incidentId: z.string(),
      priorityRank: z.number().int().min(1),
      priorityScore: z.number().min(0),
      severity: z.number().int().min(0),
      lossPerMinuteCents: z.number().int().min(0),
      analysisStatus: z.enum(['ANALYZED', 'FAILED']),
      diagnosis: EnrichedAgentDiagnosisSchema.nullable(),
      error: z.string().nullable(),
    }),
  ),
  correlation: z.object({
    status: z.enum(['INDEPENDENT', 'POSSIBLY_RELATED', 'INSUFFICIENT_EVIDENCE']),
    explanation: z.string(),
  }),
  summaries: z.object({
    operations: z.string(),
    executive: z.string(),
  }),
});

export type MultiIncidentAnalysis = z.infer<typeof MultiIncidentAnalysisSchema>;
