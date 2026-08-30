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

export type DiagnosticDimensions = z.infer<typeof DiagnosticDimensionsSchema>;

const AgentDiagnosisObjectSchema = z.object({
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
  });

function validateEvidenceStatus(
  diagnosis: z.infer<typeof AgentDiagnosisObjectSchema>,
  context: z.RefinementCtx,
) {
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
}

export const AgentDiagnosisSchema = AgentDiagnosisObjectSchema.superRefine(validateEvidenceStatus);

export const EnrichedAgentDiagnosisSchema = AgentDiagnosisObjectSchema.extend({
  confidenceAnalysis: z.object({
    detectorConfidence: z.number().min(0).max(1).nullable(),
    rootCauseConfidence: z.number().min(0).max(1).nullable(),
    score: z.number().min(0).max(1),
    level: z.enum(['LOW', 'MEDIUM', 'HIGH']),
    factors: z.array(z.object({
      code: z.enum([
        'OBSERVED_SAMPLE',
        'BASELINE_SAMPLE',
        'DROP_MAGNITUDE',
        'HEALTHY_SIBLINGS',
        'ROOT_CAUSE_ISOLATION',
      ]),
      effect: z.enum(['SUPPORTS', 'LIMITS', 'NEUTRAL']),
      statement: z.string(),
    })),
    limitations: z.array(z.string()),
  }),
  ruledOutHypotheses: z.array(z.object({
    hypothesis: z.string(),
    reason: z.string(),
    controlScope: DiagnosticDimensionsSchema,
  })),
  counterfactualImpact: z.object({
    estimatedRecoverableApprovalsPerMinute: z.number().nullable(),
    estimatedRecoverableApprovalsPerHour: z.number().nullable(),
    estimatedRecoverableRevenuePerHourCents: z.number(),
  }),
  diagnosisTrace: z.array(z.object({
    order: z.number().int().min(1),
    type: z.enum([
      'AFFECTED_SCOPE',
      'HEALTHY_CONTROL',
      'ROOT_CAUSE',
      'INSUFFICIENT_EVIDENCE',
    ]),
    scope: DiagnosticDimensionsSchema,
    statement: z.string(),
    baselineValue: z.number().nullable(),
    observedValue: z.number().nullable(),
    attempts: z.number().nullable(),
  })),
}).superRefine(validateEvidenceStatus);

export type AgentDiagnosis = z.infer<typeof AgentDiagnosisSchema>;
export type EnrichedAgentDiagnosis = z.infer<typeof EnrichedAgentDiagnosisSchema>;
