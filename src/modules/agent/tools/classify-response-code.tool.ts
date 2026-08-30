import { tool } from '@openai/agents';
import { z } from 'zod';
import { classifyTransaction } from '../../../common/yuno-taxonomy.js';

const ClassifyResponseCodeParameters = z.object({
  responseCode: z.string().trim().min(1),
  transactionStatus: z.string().trim().min(1).optional(),
  merchantAdviceCode: z.string().trim().min(1).optional(),
});

export function createClassifyResponseCodeTool() {
  return tool({
    name: 'classify_response_code',
    description:
      'Deterministically classify a Yuno response_code. HARD/SOFT semantics come from the canonical taxonomy; failureDomain and actionability are our operational interpretation. This tool does not perform remediation.',
    parameters: ClassifyResponseCodeParameters,
    execute: ({ responseCode, transactionStatus, merchantAdviceCode }) =>
      classifyTransaction({ responseCode, transactionStatus, merchantAdviceCode }),
  });
}
