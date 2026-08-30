import { classifyTransaction } from '../../common/yuno-taxonomy.js';

export type YunoResponseCodeActionability = 'ISSUER_SIDE' | 'ACTIONABLE' | 'OTHER' | 'UNKNOWN';
export type YunoResponseCodeCategory =
  | 'ISSUER' | 'EXPIRED_CARD' | 'FRAUD_RULES' | 'CHECKOUT_DATA' | 'AUTHENTICATION'
  | 'INTEGRATION' | 'PROVIDER_CONFIGURATION' | 'OTHER' | 'UNKNOWN';
export type YunoResponseCodeRetryability = 'HARD' | 'UNKNOWN';
export type YunoResponseCodeClassification = {
  code: string;
  actionability: YunoResponseCodeActionability;
  category: YunoResponseCodeCategory;
  retryability: YunoResponseCodeRetryability;
};

/** Compatibility adapter. Canonical response-code semantics live in common/yuno-taxonomy.ts. */
export function classifyYunoResponseCode(responseCode: string): YunoResponseCodeClassification {
  const canonical = classifyTransaction({ responseCode })!;
  return {
    code: canonical.code,
    actionability: canonical.actionability === 'LIMITED' ? 'OTHER' : canonical.actionability,
    category: categoryFromDomain(canonical.failureDomain),
    retryability: canonical.declineType === 'HARD' ? 'HARD' : 'UNKNOWN',
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

function categoryFromDomain(domain: string): YunoResponseCodeCategory {
  switch (domain) {
    case 'ISSUER': return 'ISSUER';
    case 'FRAUD_SCREENING': return 'FRAUD_RULES';
    case 'MERCHANT_DATA': return 'CHECKOUT_DATA';
    case 'AUTHENTICATION_3DS': return 'AUTHENTICATION';
    case 'PROVIDER':
    case 'PRE_PROVIDER': return 'INTEGRATION';
    case 'PROVIDER_CONFIGURATION': return 'PROVIDER_CONFIGURATION';
    case 'OTHER': return 'OTHER';
    default: return 'UNKNOWN';
  }
}
