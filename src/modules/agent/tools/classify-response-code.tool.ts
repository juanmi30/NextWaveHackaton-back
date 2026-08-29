import { tool } from '@openai/agents';
import { z } from 'zod';
import { classifyYunoResponseCode } from '../yuno-response-code.js';

const ClassifyResponseCodeParameters = z.object({
  responseCode: z.string().trim().min(1),
});

export function createClassifyResponseCodeTool() {
  return tool({
    name: 'classify_response_code',
    description:
      'Deterministically classify a relevant Yuno response_code by operational actionability, category, and known retryability. This tool does not detect anomalies or execute actions.',
    parameters: ClassifyResponseCodeParameters,
    execute: ({ responseCode }) => classifyYunoResponseCode(responseCode),
  });
}
