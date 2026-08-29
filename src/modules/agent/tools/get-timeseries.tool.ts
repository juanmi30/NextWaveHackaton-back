import { tool } from '@openai/agents';
import { z } from 'zod';
import { AnalyticsService } from '../../analytics/analytics.service.js';

const TimeseriesParameters = z.object({
  minutes: z.number().int().min(5).max(1440).default(120),
  bucketMinutes: z.number().int().min(1).max(120).default(5),
  provider: z.string().min(1).optional(),
  country: z.string().min(1).optional(),
  merchant: z.string().min(1).optional(),
  method: z.string().min(1).optional(),
  issuingBank: z.string().min(1).optional(),
});

export function createGetTimeseriesTool(analytics: AnalyticsService) {
  return tool({
    name: 'get_timeseries',
    description:
      'Read backend-calculated approval-rate and latency buckets to establish onset, persistence, or recovery.',
    parameters: TimeseriesParameters,
    execute: ({ minutes, bucketMinutes, ...dimensions }) =>
      analytics.timeseries(minutes, bucketMinutes, dimensions),
  });
}
