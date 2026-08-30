import {
  classifyFailureReason,
  type FailureActionability,
  type FailureCategory,
} from '../../common/payment-failure-taxonomy.js';
import { alertTeamsForFailureDomain } from '../../common/operational-ownership.js';

/**
 * Roles operativos. No son "niveles" de jerarquia: son especialidades.
 * La jerarquia la impone la politica de escalamiento, no el rol.
 */
export const RECIPIENT_ROLES = [
  'CHECKOUT_ENGINEER',
  'INTEGRATIONS_ENGINEER',
  'PROVIDER_MANAGER',
  'RISK_ANALYST',
  'MERCHANT_SUCCESS',
  'PAYMENTS_OPS',
  'ADMIN',
] as const;

export type RecipientRole = (typeof RECIPIENT_ROLES)[number];

export type IncidentScope = {
  merchant?: string;
  provider?: string;
  method?: string;
  country?: string;
  issuingBank?: string;
  failureReason?: string;
};

export type RoutingDecision = {
  category: FailureCategory | 'NO_CONCENTRATED_REASON';
  actionability: FailureActionability;
  roles: RecipientRole[];
  reason: string;
};

/**
 * A quien le compete un incidente.
 *
 * La decision NO se toma por severidad ni por proveedor concreto: se toma por
 * el dominio canonico del motivo de fallo, usando `common/yuno-taxonomy.ts`
 * mediante su adapter compatible. Un codigo de rechazo que el equipo
 * nunca ha visto cae en UNKNOWN y termina en la guardia general, no en el
 * vacio.
 */
export function routeIncident(scope: IncidentScope, severity: number): RoutingDecision {
  const classification = classifyFailureReason(scope.failureReason);

  // El diagnostico no se concentro en un motivo de fallo: la caida es
  // transversal (un proveedor caido, un pais entero). Eso es guardia general.
  if (!classification) {
    return {
      category: 'NO_CONCENTRATED_REASON',
      actionability: 'UNKNOWN',
      roles: withSeverityFloor(['PAYMENTS_OPS'], severity),
      reason:
        'La degradacion no se concentra en un motivo de fallo concreto, asi que se trata como caida transversal y va a la guardia general.',
    };
  }

  const roles: RecipientRole[] = alertTeamsForFailureDomain(classification.failureDomain);

  return {
    category: classification.category,
    actionability: classification.actionability,
    roles: withSeverityFloor(roles, severity),
    reason: buildReason(classification.category, classification.actionability, classification.code),
  };
}

/**
 * A partir de severidad 3 la guardia general entra desde el primer aviso.
 * Un especialista puede estar en una reunion; operaciones siempre esta.
 */
function withSeverityFloor(roles: RecipientRole[], severity: number): RecipientRole[] {
  const out = [...roles];
  if (severity >= 3 && !out.includes('PAYMENTS_OPS')) out.push('PAYMENTS_OPS');
  return out;
}

function buildReason(
  category: FailureCategory,
  actionability: FailureActionability,
  code: string,
): string {
  const explanations: Record<FailureCategory, string> = {
    DATA_QUALITY: 'los datos que llegan del checkout vienen mal formados',
    AUTHENTICATION: 'el flujo de autenticacion 3DS esta fallando',
    INTEGRATION: 'la integracion con el proveedor esta devolviendo errores',
    PROVIDER_CONFIGURATION: 'la configuracion o las credenciales del proveedor no son validas',
    FRAUD: 'las reglas antifraude estan rechazando trafico',
    CARD_EXPIRY: 'se concentran tarjetas vencidas',
    ISSUER_DECLINE: 'el rechazo viene del banco emisor',
    OTHER: 'el motivo no encaja en una categoria accionable',
    UNKNOWN: 'el codigo de rechazo no esta en la taxonomia conocida',
  };

  const suffix =
    actionability === 'ISSUER_SIDE'
      ? ' No es accionable desde Yuno: el aviso es informativo y para conversar con el comercio.'
      : actionability === 'LIMITED'
        ? ' La capacidad de intervencion es limitada.'
        : '';

  return `El motivo dominante es ${code} (${category}): ${explanations[category]}.${suffix}`;
}

/**
 * ¿Este destinatario cubre este incidente?
 *
 * Regla: un alcance vacio cubre todo. Si el destinatario declara un alcance en
 * una dimension y el incidente FIJA esa dimension con otro valor, queda fuera.
 * Si el incidente no fija esa dimension, no se puede descartar que le afecte y
 * se le notifica.
 *
 * Es deliberadamente inclusivo: en operaciones de pagos, un aviso de mas cuesta
 * una lectura; uno de menos cuesta dinero durante todo el incidente.
 */
export function coversScope(
  recipient: { merchants: string[]; providers: string[]; countries: string[] },
  scope: IncidentScope,
): boolean {
  return (
    dimensionMatches(recipient.merchants, scope.merchant) &&
    dimensionMatches(recipient.providers, scope.provider) &&
    dimensionMatches(recipient.countries, scope.country)
  );
}

function dimensionMatches(allowed: string[], value?: string): boolean {
  if (allowed.length === 0) return true;
  if (!value) return true;
  return allowed.includes(value);
}

/** Convierte un fingerprint canonico ("provider=dLocal|country=BR") a scope. */
export function scopeFromFingerprint(fingerprint: string): IncidentScope {
  const scope: IncidentScope = {};
  for (const part of fingerprint.split('|')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const key = part.slice(0, separator);
    const value = part.slice(separator + 1);
    if (key in EMPTY_SCOPE) {
      (scope as Record<string, string>)[key] = value;
    }
  }
  return scope;
}

const EMPTY_SCOPE: Required<Record<keyof IncidentScope, true>> = {
  merchant: true,
  provider: true,
  method: true,
  country: true,
  issuingBank: true,
  failureReason: true,
};
