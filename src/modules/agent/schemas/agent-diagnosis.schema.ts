import { z } from 'zod';

export const EvidenceStatusSchema = z.enum(['SUFFICIENT', 'INSUFFICIENT']);

export const DiagnosticDimensionsSchema = z.object({
  merchant: z.string().nullable(),
  provider: z.string().nullable(),
  method: z.string().nullable(),
  country: z.string().nullable(),
  issuingBank: z.string().nullable(),
  failureReason: z.string().nullable(),
});

export const AgentDiagnosisSchema = z
  .object({
    incidentId: z.string(),
    evidenceStatus: EvidenceStatusSchema,
    affectedScope: DiagnosticDimensionsSchema,
    rootCause: z
      .object({
        statement: z.string(),
        dimensions: DiagnosticDimensionsSchema,
        confidence: z.number().min(0).max(1),
      })
      .nullable(),
    impact: z.object({
      expectedApprovalRate: z.number().nullable(),
      observedApprovalRate: z.number().nullable(),
      lossPerMinuteCents: z.number().nullable(),
      startedAt: z.string().nullable(),
    }),
    evidence: z.array(
      z.object({
        statement: z.string(),
        metric: z.string().nullable(),
        baselineValue: z.number().nullable(),
        observedValue: z.number().nullable(),
        attempts: z.number().nullable(),
      }),
    ),
    recurrence: z.object({
      isRecurrence: z.boolean(),
      previousOccurrenceCount: z.number().int().min(0),
    }),
    recommendation: z.object({
      action: z.string(),
      requiresHumanApproval: z.literal(true),
    }),
    summaries: z.object({
      operations: z.string(),
      executive: z.string(),
    }),
  })
  .superRefine((diagnosis, context) => {
    if (diagnosis.evidenceStatus === 'INSUFFICIENT' && diagnosis.rootCause !== null) {
      context.addIssue({
        code: 'custom',
        path: ['rootCause'],
        message: 'rootCause must be null when evidence is insufficient',
      });
    }
    if (diagnosis.evidenceStatus === 'SUFFICIENT' && diagnosis.rootCause === null) {
      context.addIssue({
        code: 'custom',
        path: ['rootCause'],
        message: 'rootCause is required when evidence is sufficient',
      });
    }
  });

export type AgentDiagnosis = z.infer<typeof AgentDiagnosisSchema>;
