import { classifyTransaction, type Actionability, type FailureDomain } from './yuno-taxonomy.js';

export type FailureCategory =
  | 'ISSUER_DECLINE' | 'CARD_EXPIRY' | 'FRAUD' | 'DATA_QUALITY' | 'AUTHENTICATION'
  | 'INTEGRATION' | 'PROVIDER_CONFIGURATION' | 'OTHER' | 'UNKNOWN';
export type FailureActionability = Actionability;
export type Retryability = 'HARD_DECLINE' | 'UNKNOWN';

export interface FailureClassification {
  code: string;
  category: FailureCategory;
  actionability: FailureActionability;
  retryability: Retryability;
  failureDomain: FailureDomain;
}

/** Compatibility adapter. Response-code knowledge lives only in yuno-taxonomy.ts. */
export function classifyFailureReason(rawReason: string | null | undefined): FailureClassification | null {
  const canonical = classifyTransaction({ responseCode: rawReason });
  if (!canonical) return null;
  return {
    code: canonical.code,
    category: categoryFromDomain(canonical.failureDomain),
    actionability: canonical.actionability,
    retryability: canonical.declineType === 'HARD' ? 'HARD_DECLINE' : 'UNKNOWN',
    failureDomain: canonical.failureDomain,
  };
}

function categoryFromDomain(domain: FailureDomain): FailureCategory {
  switch (domain) {
    case 'ISSUER': return 'ISSUER_DECLINE';
    case 'FRAUD_SCREENING': return 'FRAUD';
    case 'MERCHANT_DATA': return 'DATA_QUALITY';
    case 'AUTHENTICATION_3DS': return 'AUTHENTICATION';
    case 'PROVIDER':
    case 'PRE_PROVIDER': return 'INTEGRATION';
    case 'PROVIDER_CONFIGURATION': return 'PROVIDER_CONFIGURATION';
    case 'OTHER': return 'OTHER';
    case 'UNKNOWN': return 'UNKNOWN';
  }
}
