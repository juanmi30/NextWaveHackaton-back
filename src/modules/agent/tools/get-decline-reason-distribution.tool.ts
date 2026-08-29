import { tool } from '@openai/agents';
import { z } from 'zod';
import { AnalyticsService } from '../../analytics/analytics.service.js';

const DeclineReasonDistributionParameters = z.object({
  merchant: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  method: z.string().min(1).optional(),
  country: z.string().min(1).optional(),
  issuingBank: z.string().min(1).optional(),
  timeWindowMinutes: z.number().int().min(5).max(1440).default(60),
  baselineHours: z.number().int().min(1).max(720).default(24),
  minSampleSize: z.number().int().min(1).max(1000).default(1),
});

export function createGetDeclineReasonDistributionTool(analytics: AnalyticsService) {
  return tool({
    name: 'get_decline_reason_distribution',
    description:
      'Compare backend-calculated decline-reason shares in current and baseline windows. Use this instead of approval-rate breakdowns for failureReason analysis.',
    parameters: DeclineReasonDistributionParameters,
    execute: (parameters) => analytics.declineReasonBreakdown(parameters),
  });
}
