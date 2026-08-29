export type YunoResponseCodeActionability = 'ISSUER_SIDE' | 'ACTIONABLE' | 'OTHER' | 'UNKNOWN';

export type YunoResponseCodeCategory =
  | 'ISSUER'
  | 'EXPIRED_CARD'
  | 'FRAUD_RULES'
  | 'CHECKOUT_DATA'
  | 'AUTHENTICATION'
  | 'INTEGRATION'
  | 'PROVIDER_CONFIGURATION'
  | 'OTHER'
  | 'UNKNOWN';

export type YunoResponseCodeRetryability = 'HARD' | 'UNKNOWN';

export type YunoResponseCodeClassification = {
  code: string;
  actionability: YunoResponseCodeActionability;
  category: YunoResponseCodeCategory;
  retryability: YunoResponseCodeRetryability;
};

const CODES_BY_CLASSIFICATION: Array<{
  actionability: YunoResponseCodeActionability;
  category: YunoResponseCodeCategory;
  codes: readonly string[];
}> = [
  {
    actionability: 'ISSUER_SIDE',
    category: 'ISSUER',
    codes: [
      'INSUFFICIENT_FUNDS',
      'DO_NOT_HONOR',
      'CALL_FOR_AUTHORIZE',
      'DECLINED_BY_BANK',
      'RESTRICTED_BY_BANK',
      'DISABLED',
      'REFER_TO_CARD_ISSUER',
      'REPORTED_LOST',
      'REPORTED_STOLEN',
    ],
  },
  { actionability: 'ACTIONABLE', category: 'EXPIRED_CARD', codes: ['EXPIRED_CARD', 'EXPIRED'] },
  { actionability: 'ACTIONABLE', category: 'FRAUD_RULES', codes: ['FRAUD_VALIDATION'] },
  {
    actionability: 'ACTIONABLE',
    category: 'CHECKOUT_DATA',
    codes: [
      'INVALID_CVV',
      'INVALID_CARD_DATA',
      'INVALID_PARAMETERS',
      'MISSING_PARAMETERS',
      'BAD_FILLED_INFO',
      'INVALID_CARD_NUMBER',
      'INVALID_SECURITY_CODE',
      'INVALID_AMOUNT',
      'INVALID_TRANSACTION',
    ],
  },
  {
    actionability: 'ACTIONABLE',
    category: 'AUTHENTICATION',
    codes: ['THREE_D_SECURE_REQUIRED', 'REJECTED_THREE_D_SECURE_REQUIRED'],
  },
  {
    actionability: 'ACTIONABLE',
    category: 'INTEGRATION',
    codes: ['TERMINAL_ERROR', 'UNKNOWN_ERROR', 'ERROR', 'INVALID_RESPONSE_FORMAT', 'TRANSACTION_NOT_FOUND'],
  },
  {
    actionability: 'ACTIONABLE',
    category: 'PROVIDER_CONFIGURATION',
    codes: [
      'DECLINED_BY_PROVIDER',
      'INVALID_ISSUER',
      'INVALID_MERCHANT',
      'INVALID_STATUS',
      'INVALID_API',
      'INVALID_API_VERSION',
      'INVALID_CREDENTIALS',
      'UNSUPPORTED_OPERATION',
      'UNAVAILABLE_PAYMENT_METHOD',
      'COUNTRY_NOT_SUPPORTED',
      'CURRENCY_NOT_ALLOWED',
      'ACQUIRE_CONTINGENCY',
      'BANK_NOT_SUPPORTED',
      'ISSUER_VIOLATION',
      'USER_RESTRICTION',
      'REQUESTS_EXCEEDED',
    ],
  },
  {
    actionability: 'OTHER',
    category: 'OTHER',
    codes: [
      'CANCELLED_BY_USER',
      'DUPLICATED_TRANSACTION',
      'FIRST_USE',
      'NO_RETRY_LIFE_CYCLE',
      'NO_RETRY_POLICY',
      'NO_RETRY_SECURITY',
    ],
  },
];

const CLASSIFICATION_BY_CODE = new Map(
  CODES_BY_CLASSIFICATION.flatMap(({ actionability, category, codes }) =>
    codes.map((code) => [code, { actionability, category }] as const),
  ),
);

export const YUNO_HARD_DECLINE_CODES = new Set([
  'EXPIRED_CARD',
  'INVALID_CARD_DATA',
  'INVALID_CARD_NUMBER',
  'INVALID_SECURITY_CODE',
  'MISSING_PARAMETERS',
  'COUNTRY_NOT_SUPPORTED',
  'CURRENCY_NOT_ALLOWED',
  'REPORTED_LOST',
  'REPORTED_STOLEN',
  'NO_RETRY_LIFE_CYCLE',
  'NO_RETRY_POLICY',
  'NO_RETRY_SECURITY',
]);

export function classifyYunoResponseCode(responseCode: string): YunoResponseCodeClassification {
  const code = responseCode.trim().toUpperCase();
  const classification = CLASSIFICATION_BY_CODE.get(code);

  return {
    code,
    actionability: classification?.actionability ?? 'UNKNOWN',
    category: classification?.category ?? 'UNKNOWN',
    retryability: YUNO_HARD_DECLINE_CODES.has(code) ? 'HARD' : 'UNKNOWN',
  };
}

export function classifyYunoTransactionStatus(status: string) {
  const normalizedStatus = status.trim().toUpperCase();
  if (normalizedStatus === 'REJECTED') {
    return { status: normalizedStatus, meaning: 'YUNO_PRE_PROVIDER_REJECTION' as const };
  }
  if (normalizedStatus === 'ERROR') {
    return { status: normalizedStatus, meaning: 'INTEGRATION_OR_PROVIDER_ERROR' as const };
  }
  return { status: normalizedStatus, meaning: 'OTHER' as const };
}
