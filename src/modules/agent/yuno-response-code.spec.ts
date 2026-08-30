import { describe, expect, it } from 'vitest';
import {
  classifyYunoResponseCode,
  classifyYunoTransactionStatus,
} from './yuno-response-code.js';

describe('classifyYunoResponseCode', () => {
  it.each([
    [
      'DO_NOT_HONOR',
      { actionability: 'ISSUER_SIDE', category: 'ISSUER', retryability: 'UNKNOWN' },
    ],
    [
      'INVALID_CARD_NUMBER',
      { actionability: 'ACTIONABLE', category: 'CHECKOUT_DATA', retryability: 'HARD' },
    ],
    [
      'THREE_D_SECURE_REQUIRED',
      { actionability: 'ACTIONABLE', category: 'AUTHENTICATION', retryability: 'UNKNOWN' },
    ],
    [
      'INVALID_CREDENTIALS',
      {
        actionability: 'ACTIONABLE',
        category: 'PROVIDER_CONFIGURATION',
        retryability: 'UNKNOWN',
      },
    ],
    ['NO_RETRY_POLICY', { actionability: 'OTHER', category: 'OTHER', retryability: 'HARD' }],
    [
      'NOT_DOCUMENTED',
      { actionability: 'UNKNOWN', category: 'UNKNOWN', retryability: 'UNKNOWN' },
    ],
  ])('classifies %s deterministically', (code, expected) => {
    expect(classifyYunoResponseCode(code)).toEqual({ code, ...expected });
  });

  it('keeps transaction status REJECTED distinct from response_code classification', () => {
    expect(classifyYunoTransactionStatus('REJECTED')).toEqual({
      status: 'REJECTED',
      meaning: 'YUNO_PRE_PROVIDER_REJECTION',
    });
    expect(classifyYunoResponseCode('REJECTED')).toEqual({
      code: 'REJECTED',
      actionability: 'UNKNOWN',
      category: 'UNKNOWN',
      retryability: 'UNKNOWN',
    });
    expect(classifyYunoResponseCode('ERROR').category).toBe('INTEGRATION');
  });
});
