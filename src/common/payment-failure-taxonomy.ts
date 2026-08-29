export type FailureCategory =
  | 'ISSUER_DECLINE'
  | 'CARD_EXPIRY'
  | 'FRAUD'
  | 'DATA_QUALITY'
  | 'AUTHENTICATION'
  | 'INTEGRATION'
  | 'PROVIDER_CONFIGURATION'
  | 'OTHER'
  | 'UNKNOWN';

export type FailureActionability =
  | 'ISSUER_SIDE'
  | 'ACTIONABLE'
  | 'LIMITED'
  | 'UNKNOWN';

export type Retryability =
  | 'HARD_DECLINE'
  | 'UNKNOWN';

export interface FailureClassification {
  code: string;
  category: FailureCategory;
  actionability: FailureActionability;
  retryability: Retryability;
}

const ISSUER_DECLINES = new Set([
  'INSUFFICIENT_FUNDS',
  'DO_NOT_HONOR',
  'CALL_FOR_AUTHORIZE',
  'DECLINED_BY_BANK',
  'RESTRICTED_BY_BANK',
  'DISABLED',
  'REFER_TO_CARD_ISSUER',
  'REPORTED_LOST',
  'REPORTED_STOLEN',
]);

const CARD_EXPIRY = new Set([
  'EXPIRED_CARD',
  'EXPIRED',
]);

const FRAUD = new Set([
  'FRAUD_VALIDATION',
]);

const DATA_QUALITY = new Set([
  'INVALID_CVV',
  'INVALID_CARD_DATA',
  'INVALID_PARAMETERS',
  'MISSING_PARAMETERS',
  'BAD_FILLED_INFO',
  'INVALID_CARD_NUMBER',
  'INVALID_SECURITY_CODE',
  'INVALID_AMOUNT',
  'INVALID_TRANSACTION',
]);

const AUTHENTICATION = new Set([
  'THREE_D_SECURE_REQUIRED',
  'REJECTED_THREE_D_SECURE_REQUIRED',
]);

const INTEGRATION = new Set([
  'TERMINAL_ERROR',
  'UNKNOWN_ERROR',
  'ERROR',
  'INVALID_RESPONSE_FORMAT',
  'TRANSACTION_NOT_FOUND',
]);

const PROVIDER_CONFIGURATION = new Set([
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
]);

const OTHER = new Set([
  'CANCELLED_BY_USER',
  'DUPLICATED_TRANSACTION',
  'FIRST_USE',
  'NO_RETRY_LIFE_CYCLE',
  'NO_RETRY_POLICY',
  'NO_RETRY_SECURITY',
]);

/*
 * Esta lista es deliberadamente incompleta.
 *
 * El mentor confirmó estos casos como hard declines,
 * pero indicó que existen más.
 *
 * No asumimos que "no hard" significa automáticamente soft.
 */
const KNOWN_HARD_DECLINES = new Set([
  'EXPIRED_CARD',
  'EXPIRED',
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

export function classifyFailureReason(
  rawReason: string | null | undefined,
): FailureClassification | null {
  if (!rawReason) {
    return null;
  }

  const code = rawReason
    .trim()
    .toUpperCase();

  let category: FailureCategory =
    'UNKNOWN';

  let actionability: FailureActionability =
    'UNKNOWN';

  if (ISSUER_DECLINES.has(code)) {
    category = 'ISSUER_DECLINE';
    actionability = 'ISSUER_SIDE';
  } else if (CARD_EXPIRY.has(code)) {
    category = 'CARD_EXPIRY';
    actionability = 'ACTIONABLE';
  } else if (FRAUD.has(code)) {
    category = 'FRAUD';
    actionability = 'ACTIONABLE';
  } else if (DATA_QUALITY.has(code)) {
    category = 'DATA_QUALITY';
    actionability = 'ACTIONABLE';
  } else if (AUTHENTICATION.has(code)) {
    category = 'AUTHENTICATION';
    actionability = 'ACTIONABLE';
  } else if (INTEGRATION.has(code)) {
    category = 'INTEGRATION';
    actionability = 'ACTIONABLE';
  } else if (
    PROVIDER_CONFIGURATION.has(code)
  ) {
    category =
      'PROVIDER_CONFIGURATION';

    actionability = 'ACTIONABLE';
  } else if (OTHER.has(code)) {
    category = 'OTHER';
    actionability = 'LIMITED';
  }

  return {
    code,
    category,
    actionability,

    retryability:
      KNOWN_HARD_DECLINES.has(code)
        ? 'HARD_DECLINE'
        : 'UNKNOWN',
  };
}