import { describe, expect, it } from 'vitest';
import { createClassifyResponseCodeTool } from './classify-response-code.tool.js';

describe('classify_response_code tool', () => {
  it('returns canonical taxonomy data without model classification', async () => {
    const tool = createClassifyResponseCodeTool();
    const raw = await tool.invoke({} as never, JSON.stringify({
      responseCode: 'PROVIDER_INVALID_CREDENTIALS',
      transactionStatus: 'ERROR',
      merchantAdviceCode: 'DO_NOT_TRY_AGAIN',
    }));
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;

    expect(result).toMatchObject({
      code: 'PROVIDER_INVALID_CREDENTIALS',
      transactionStatus: 'ERROR',
      declineType: 'HARD',
      failureDomain: 'PROVIDER_CONFIGURATION',
      actionability: 'ACTIONABLE',
      retryAdvice: 'DO_NOT_RETRY',
      unknownCode: false,
    });
  });
});
