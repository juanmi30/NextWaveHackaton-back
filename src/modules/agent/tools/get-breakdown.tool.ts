import { tool } from '@openai/agents';
import { z } from 'zod';
import { AnalyticsService } from '../../analytics/analytics.service.js';

const BreakdownParameters = z.object({
  groupBy: z.enum([
    'merchant',
    'provider',
    'method',
    'country',
    'issuingBank',
    'failureReason',
    'route',
  ]),
  merchant: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  method: z.string().min(1).optional(),
  country: z.string().min(1).optional(),
  issuingBank: z.string().min(1).optional(),
  failureReason: z.string().min(1).optional(),
  timeWindowMinutes: z.number().int().min(5).max(1440).default(60),
  baselineHours: z.number().int().min(1).max(720).default(24),
  minSampleSize: z.number().int().min(1).max(1000).default(10),
});

export function createGetBreakdownTool(analytics: AnalyticsService) {
  return tool({
    name: 'get_breakdown',
    description:
      'Compare current and baseline payment performance by a dimension. Use it only to separate specific root-cause hypotheses.',
    parameters: BreakdownParameters,
    execute: (parameters) => analytics.breakdown(parameters),
  });
}
