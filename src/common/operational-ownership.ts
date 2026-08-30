import type { FailureDomain } from './yuno-taxonomy.js';

export const OPERATIONAL_TEAMS = [
  'PAYMENTS_OPS', 'PROVIDER_MANAGER', 'INTEGRATIONS_ENGINEER',
  'MERCHANT_SUCCESS', 'CHECKOUT_ENGINEER', 'RISK_ANALYST',
] as const;
export type OperationalTeam = (typeof OPERATIONAL_TEAMS)[number];
export type OperationalOwnership = {
  suspectedDomain: FailureDomain;
  primaryTeam: OperationalTeam;
  supportingTeams: OperationalTeam[];
  statement: string;
};

type OwnershipEntry = Omit<OperationalOwnership, 'suspectedDomain'> & { alertTeams: OperationalTeam[] };

const OWNERSHIP_BY_DOMAIN: Record<FailureDomain, OwnershipEntry> = {
  ISSUER: { primaryTeam: 'MERCHANT_SUCCESS', supportingTeams: ['PAYMENTS_OPS'], alertTeams: ['MERCHANT_SUCCESS'], statement: 'Evidence points to an issuer-side failure. Escalate issuer-specific evidence through the provider/acquirer path. No automatic remediation has been executed.' },
  PROVIDER: { primaryTeam: 'PAYMENTS_OPS', supportingTeams: ['PROVIDER_MANAGER'], alertTeams: ['INTEGRATIONS_ENGINEER'], statement: 'Evidence points to provider behavior. Payments Operations should coordinate investigation with the provider manager. No automatic remediation has been executed.' },
  PROVIDER_CONFIGURATION: { primaryTeam: 'INTEGRATIONS_ENGINEER', supportingTeams: ['PROVIDER_MANAGER'], alertTeams: ['INTEGRATIONS_ENGINEER', 'PROVIDER_MANAGER'], statement: 'Evidence points to provider configuration or credentials. Integration ownership should verify configuration with the provider manager. No automatic remediation has been executed.' },
  PRE_PROVIDER: { primaryTeam: 'INTEGRATIONS_ENGINEER', supportingTeams: ['PAYMENTS_OPS'], alertTeams: ['INTEGRATIONS_ENGINEER'], statement: 'Evidence points to a pre-provider rejection. Integration ownership should validate the request before provider processing. No automatic remediation has been executed.' },
  AUTHENTICATION_3DS: { primaryTeam: 'CHECKOUT_ENGINEER', supportingTeams: ['PAYMENTS_OPS'], alertTeams: ['CHECKOUT_ENGINEER'], statement: 'Evidence points to the 3DS authentication flow. Checkout Engineering should investigate with Payments Operations. No automatic remediation has been executed.' },
  FRAUD_SCREENING: { primaryTeam: 'RISK_ANALYST', supportingTeams: ['PAYMENTS_OPS'], alertTeams: ['RISK_ANALYST'], statement: 'Evidence points to fraud-screening behavior. Risk should review the stored evidence. No automatic remediation has been executed.' },
  MERCHANT_DATA: { primaryTeam: 'CHECKOUT_ENGINEER', supportingTeams: ['MERCHANT_SUCCESS'], alertTeams: ['CHECKOUT_ENGINEER'], statement: 'Evidence points to merchant or checkout data quality. Checkout Engineering should validate the payload with Merchant Success. No automatic remediation has been executed.' },
  OTHER: { primaryTeam: 'PAYMENTS_OPS', supportingTeams: [], alertTeams: ['PAYMENTS_OPS'], statement: 'The failure is not isolated to a specialized operational domain. Payments Operations should review the evidence. No automatic remediation has been executed.' },
  UNKNOWN: { primaryTeam: 'PAYMENTS_OPS', supportingTeams: [], alertTeams: ['PAYMENTS_OPS'], statement: 'The available response code does not identify a known operational domain. Payments Operations should review the evidence. No automatic remediation has been executed.' },
};

export function ownershipForFailureDomain(domain: FailureDomain): OperationalOwnership {
  const { alertTeams: _, ...ownership } = OWNERSHIP_BY_DOMAIN[domain];
  return { suspectedDomain: domain, ...ownership };
}

export function alertTeamsForFailureDomain(domain: FailureDomain): OperationalTeam[] {
  return [...OWNERSHIP_BY_DOMAIN[domain].alertTeams];
}
