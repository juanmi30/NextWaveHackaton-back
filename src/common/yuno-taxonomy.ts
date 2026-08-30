/**
 * Taxonomia de transacciones de Yuno — v2
 * ======================================
 *
 * FUENTE OFICIAL (documentacion publica de Yuno):
 *   https://docs.y.uno/reference/payments/status-and-response-codes/transaction
 *   https://docs.y.uno/reference/payments/status-and-response-codes/merchant-advice-codes-mac
 *
 * Lo que es DATO OFICIAL de Yuno, transcrito de esas tablas:
 *   - los transaction types
 *   - los transaction statuses
 *   - que response_code pertenece a que status
 *   - la clasificacion HARD / SOFT / N/A de cada decline
 *   - la lista normalizada de Merchant Advice Codes
 *
 * Lo que es INFERENCIA NUESTRA (product taxonomy, no oficial):
 *   - `failureDomain`: el dominio LOGICO del producto al que atribuimos el fallo
 *   - `actionability`: si el equipo puede intervenir o no
 *
 * IMPORTANTE: `failureDomain` NO son nombres de microservicios internos de Yuno.
 * La documentacion publica describe etapas, proveedores, conexiones, antifraude,
 * 3DS y routing, pero no publica una topologia interna. Son agrupaciones nuestras
 * para poder enrutar alertas y explicar incidentes.
 */

// ---------------------------------------------------------------------------
// Transaction types — OFICIAL
// ---------------------------------------------------------------------------

export const YUNO_TRANSACTION_TYPES = [
  'PURCHASE',
  'AUTHORIZE',
  'CAPTURE',
  'REFUND',
  'CANCEL',
  'VERIFY',
  'CHARGEBACK',
  'THREE_D_SECURE',
  'FRAUD_SCREENING',
  'SPLIT_TRANSFER_REVERSAL',
  'SPLIT_TRANSFER',
  'SPLIT_TRANSFER_REVERSE',
] as const;

export type YunoTransactionType = (typeof YUNO_TRANSACTION_TYPES)[number];

// ---------------------------------------------------------------------------
// Transaction statuses — OFICIAL
// ---------------------------------------------------------------------------

export const YUNO_TRANSACTION_STATUSES = [
  'SUCCEEDED',
  'WON',
  'CREATED',
  'PENDING',
  'DECLINED',
  'REJECTED',
  'ERROR',
  'EXPIRED',
  'LOST',
  'PREVENTED',
] as const;

export type YunoTransactionStatus = (typeof YUNO_TRANSACTION_STATUSES)[number];

// ---------------------------------------------------------------------------
// Hard / Soft decline — OFICIAL
// ---------------------------------------------------------------------------

/** `N_A` es el valor que Yuno publica como "N/A" para codigos no declinatorios. */
export type DeclineType = 'HARD' | 'SOFT' | 'N_A' | 'UNKNOWN';

// ---------------------------------------------------------------------------
// Merchant Advice Codes — OFICIAL
// ---------------------------------------------------------------------------

export const YUNO_MERCHANT_ADVICE_CODES = [
  'UPDATE_INFORMATION',
  'TRY_AGAIN_LATER',
  'DO_NOT_TRY_AGAIN',
  'REQUIREMENTS_NOT_FULFILLED',
  'NO_RETRY_LIFE_CYCLE',
  'RETRY_AFTER_1_H',
  'RETRY_AFTER_24_H',
  'RETRY_AFTER_2_D',
  'RETRY_AFTER_4_D',
  'RETRY_AFTER_6_D',
  'RETRY_AFTER_8_D',
  'RETRY_AFTER_10_D',
  'NO_RETRY_POLICY',
  'NO_RETRY_SECURITY',
  'MULTIPLE_USE_CARD',
] as const;

export type YunoMerchantAdviceCode = (typeof YUNO_MERCHANT_ADVICE_CODES)[number];

/** Agrupacion operativa del MAC. Inferencia nuestra sobre datos oficiales. */
export type RetryAdvice =
  | 'DO_NOT_RETRY'
  | 'RETRY_LATER'
  | 'UPDATE_INFORMATION'
  | 'UNKNOWN';

const MAC_TO_ADVICE: Record<string, RetryAdvice> = {
  UPDATE_INFORMATION: 'UPDATE_INFORMATION',
  REQUIREMENTS_NOT_FULFILLED: 'UPDATE_INFORMATION',
  TRY_AGAIN_LATER: 'RETRY_LATER',
  RETRY_AFTER_1_H: 'RETRY_LATER',
  RETRY_AFTER_24_H: 'RETRY_LATER',
  RETRY_AFTER_2_D: 'RETRY_LATER',
  RETRY_AFTER_4_D: 'RETRY_LATER',
  RETRY_AFTER_6_D: 'RETRY_LATER',
  RETRY_AFTER_8_D: 'RETRY_LATER',
  RETRY_AFTER_10_D: 'RETRY_LATER',
  DO_NOT_TRY_AGAIN: 'DO_NOT_RETRY',
  NO_RETRY_LIFE_CYCLE: 'DO_NOT_RETRY',
  NO_RETRY_POLICY: 'DO_NOT_RETRY',
  NO_RETRY_SECURITY: 'DO_NOT_RETRY',
  MULTIPLE_USE_CARD: 'DO_NOT_RETRY',
};

export function adviceFromMerchantAdviceCode(mac?: string | null): RetryAdvice {
  if (!mac) return 'UNKNOWN';
  return MAC_TO_ADVICE[mac.trim().toUpperCase()] ?? 'UNKNOWN';
}

// ---------------------------------------------------------------------------
// Failure domains — INFERENCIA NUESTRA (product taxonomy / logical domains)
// ---------------------------------------------------------------------------

export const FAILURE_DOMAINS = [
  'PROVIDER',               // el proveedor falla o no responde
  'PROVIDER_CONFIGURATION', // credenciales, API, cuenta o conexion mal configurada
  'PRE_PROVIDER',           // Yuno rechaza antes de llegar al proveedor
  'ISSUER',                 // el banco emisor decide
  'AUTHENTICATION_3DS',     // autenticacion 3DS
  'FRAUD_SCREENING',        // reglas antifraude
  'MERCHANT_DATA',          // calidad de los datos del checkout
  'OTHER',
  'UNKNOWN',
] as const;

export type FailureDomain = (typeof FAILURE_DOMAINS)[number];

/** Quien puede intervenir. Inferencia nuestra. */
export type Actionability = 'ISSUER_SIDE' | 'ACTIONABLE' | 'LIMITED' | 'UNKNOWN';

// ---------------------------------------------------------------------------
// Tabla maestra
// ---------------------------------------------------------------------------

type CodeEntry = {
  /** Status oficial al que pertenece el codigo. */
  status: YunoTransactionStatus;
  /** HARD/SOFT publicado por Yuno. */
  declineType: DeclineType;
  /** Inferencia nuestra. */
  domain: FailureDomain;
  /** Inferencia nuestra. */
  actionability: Actionability;
};

/**
 * Transcripcion de las tablas oficiales. `status` y `declineType` salen tal cual
 * de la documentacion; `domain` y `actionability` son nuestros.
 *
 * Nota: algunos codigos aparecen en mas de un status (por ejemplo
 * COUNTRY_NOT_SUPPORTED esta en DECLINED y en REJECTED). Cuando eso ocurre se
 * resuelve con el status real de la transaccion; esta tabla guarda el caso mas
 * frecuente y `classifyTransaction()` permite sobreescribirlo.
 */
const CODES: Record<string, CodeEntry> = {
  // --- SUCCEEDED (oficial) ---
  SUCCEEDED: { status: 'SUCCEEDED', declineType: 'N_A', domain: 'OTHER', actionability: 'UNKNOWN' },
  FRAUD_VERIFIED: { status: 'SUCCEEDED', declineType: 'N_A', domain: 'FRAUD_SCREENING', actionability: 'UNKNOWN' },
  SUCCEEDED_THREE_D_SECURE: { status: 'SUCCEEDED', declineType: 'N_A', domain: 'AUTHENTICATION_3DS', actionability: 'UNKNOWN' },

  // --- PENDING (oficial) ---
  CHALLENGE_REQUIRED: { status: 'PENDING', declineType: 'N_A', domain: 'AUTHENTICATION_3DS', actionability: 'ACTIONABLE' },
  PENDING_FRAUD_REVIEW: { status: 'PENDING', declineType: 'N_A', domain: 'FRAUD_SCREENING', actionability: 'ACTIONABLE' },
  PENDING_REVIEW: { status: 'PENDING', declineType: 'N_A', domain: 'FRAUD_SCREENING', actionability: 'ACTIONABLE' },
  PENDING_PROVIDER_CONFIRMATION: { status: 'PENDING', declineType: 'N_A', domain: 'PROVIDER', actionability: 'LIMITED' },

  // --- DECLINED (oficial: HARD/SOFT segun la tabla de Yuno) ---
  ACCOUNT_STATUS: { status: 'DECLINED', declineType: 'N_A', domain: 'FRAUD_SCREENING', actionability: 'ACTIONABLE' },
  ACQUIRE_CONTINGENCY: { status: 'DECLINED', declineType: 'SOFT', domain: 'PROVIDER', actionability: 'LIMITED' },
  AUTHENTICATION_ATTEMPT: { status: 'DECLINED', declineType: 'N_A', domain: 'AUTHENTICATION_3DS', actionability: 'ACTIONABLE' },
  AUTHENTICATION_FAILED_THREE_D_SECURE: { status: 'DECLINED', declineType: 'N_A', domain: 'AUTHENTICATION_3DS', actionability: 'ACTIONABLE' },
  BAD_FILLED_INFO: { status: 'DECLINED', declineType: 'HARD', domain: 'MERCHANT_DATA', actionability: 'ACTIONABLE' },
  BANK_NOT_SUPPORTED: { status: 'DECLINED', declineType: 'SOFT', domain: 'PROVIDER_CONFIGURATION', actionability: 'ACTIONABLE' },
  CALL_FOR_AUTHORIZE: { status: 'DECLINED', declineType: 'SOFT', domain: 'ISSUER', actionability: 'ISSUER_SIDE' },
  CANCELLED_BY_USER: { status: 'DECLINED', declineType: 'SOFT', domain: 'OTHER', actionability: 'LIMITED' },
  COUNTRY_NOT_SUPPORTED: { status: 'DECLINED', declineType: 'HARD', domain: 'PROVIDER_CONFIGURATION', actionability: 'ACTIONABLE' },
  CURRENCY_NOT_ALLOWED: { status: 'DECLINED', declineType: 'HARD', domain: 'PROVIDER_CONFIGURATION', actionability: 'ACTIONABLE' },
  DECLINED_BY_BANK: { status: 'DECLINED', declineType: 'SOFT', domain: 'ISSUER', actionability: 'ISSUER_SIDE' },
  DECLINED_BY_PROVIDER: { status: 'DECLINED', declineType: 'SOFT', domain: 'PROVIDER', actionability: 'LIMITED' },
  DISABLED: { status: 'DECLINED', declineType: 'SOFT', domain: 'ISSUER', actionability: 'ISSUER_SIDE' },
  DO_NOT_HONOR: { status: 'DECLINED', declineType: 'SOFT', domain: 'ISSUER', actionability: 'ISSUER_SIDE' },
  DUPLICATED_TRANSACTION: { status: 'DECLINED', declineType: 'SOFT', domain: 'OTHER', actionability: 'ACTIONABLE' },
  // OFICIAL: EXPIRED es SOFT ("expired alternative payment method"), no HARD.
  EXPIRED: { status: 'DECLINED', declineType: 'SOFT', domain: 'OTHER', actionability: 'LIMITED' },
  EXPIRED_CARD: { status: 'DECLINED', declineType: 'HARD', domain: 'MERCHANT_DATA', actionability: 'ACTIONABLE' },
  FIRST_USE: { status: 'DECLINED', declineType: 'SOFT', domain: 'ISSUER', actionability: 'ISSUER_SIDE' },
  FRAUD_VALIDATION: { status: 'DECLINED', declineType: 'SOFT', domain: 'FRAUD_SCREENING', actionability: 'ACTIONABLE' },
  FRAUD_VERIFICATION_DECLINED: { status: 'DECLINED', declineType: 'UNKNOWN', domain: 'FRAUD_SCREENING', actionability: 'ACTIONABLE' },
  INSUFFICIENT_FUNDS: { status: 'DECLINED', declineType: 'SOFT', domain: 'ISSUER', actionability: 'ISSUER_SIDE' },
  INVALID_AMOUNT: { status: 'DECLINED', declineType: 'SOFT', domain: 'MERCHANT_DATA', actionability: 'ACTIONABLE' },
  INVALID_API: { status: 'DECLINED', declineType: 'HARD', domain: 'PROVIDER_CONFIGURATION', actionability: 'ACTIONABLE' },
  INVALID_API_VERSION: { status: 'DECLINED', declineType: 'HARD', domain: 'PROVIDER_CONFIGURATION', actionability: 'ACTIONABLE' },
  INVALID_CARD_DATA: { status: 'DECLINED', declineType: 'HARD', domain: 'MERCHANT_DATA', actionability: 'ACTIONABLE' },
  INVALID_CARD_NUMBER: { status: 'DECLINED', declineType: 'HARD', domain: 'MERCHANT_DATA', actionability: 'ACTIONABLE' },
  INVALID_CREDENTIALS: { status: 'DECLINED', declineType: 'HARD', domain: 'PROVIDER_CONFIGURATION', actionability: 'ACTIONABLE' },
  INVALID_ISSUER: { status: 'DECLINED', declineType: 'SOFT', domain: 'ISSUER', actionability: 'ISSUER_SIDE' },
  INVALID_MERCHANT: { status: 'DECLINED', declineType: 'SOFT', domain: 'PROVIDER_CONFIGURATION', actionability: 'ACTIONABLE' },
  INVALID_PARAMETERS: { status: 'DECLINED', declineType: 'HARD', domain: 'MERCHANT_DATA', actionability: 'ACTIONABLE' },
  INVALID_RESPONSE_FORMAT: { status: 'DECLINED', declineType: 'SOFT', domain: 'PROVIDER', actionability: 'ACTIONABLE' },
  INVALID_SECURITY_CODE: { status: 'DECLINED', declineType: 'HARD', domain: 'MERCHANT_DATA', actionability: 'ACTIONABLE' },
  INVALID_STATUS: { status: 'DECLINED', declineType: 'SOFT', domain: 'PROVIDER_CONFIGURATION', actionability: 'ACTIONABLE' },
  INVALID_TRANSACTION: { status: 'DECLINED', declineType: 'HARD', domain: 'MERCHANT_DATA', actionability: 'ACTIONABLE' },
  ISSUER_VIOLATION: { status: 'DECLINED', declineType: 'SOFT', domain: 'ISSUER', actionability: 'ISSUER_SIDE' },
  MISSING_PARAMETERS: { status: 'DECLINED', declineType: 'HARD', domain: 'MERCHANT_DATA', actionability: 'ACTIONABLE' },
  NO_RETRY_LIFE_CYCLE: { status: 'DECLINED', declineType: 'HARD', domain: 'ISSUER', actionability: 'ISSUER_SIDE' },
  NO_RETRY_POLICY: { status: 'DECLINED', declineType: 'HARD', domain: 'ISSUER', actionability: 'ISSUER_SIDE' },
  NO_RETRY_SECURITY: { status: 'DECLINED', declineType: 'HARD', domain: 'ISSUER', actionability: 'ISSUER_SIDE' },
  RETRY_AFTER_1_H: { status: 'DECLINED', declineType: 'HARD', domain: 'ISSUER', actionability: 'ISSUER_SIDE' },
  RETRY_AFTER_24_H: { status: 'DECLINED', declineType: 'HARD', domain: 'ISSUER', actionability: 'ISSUER_SIDE' },
  RETRY_AFTER_2_D: { status: 'DECLINED', declineType: 'HARD', domain: 'ISSUER', actionability: 'ISSUER_SIDE' },
  RETRY_AFTER_4_D: { status: 'DECLINED', declineType: 'HARD', domain: 'ISSUER', actionability: 'ISSUER_SIDE' },
  RETRY_AFTER_6_D: { status: 'DECLINED', declineType: 'HARD', domain: 'ISSUER', actionability: 'ISSUER_SIDE' },
  RETRY_AFTER_8_D: { status: 'DECLINED', declineType: 'HARD', domain: 'ISSUER', actionability: 'ISSUER_SIDE' },
  RETRY_AFTER_10_D: { status: 'DECLINED', declineType: 'HARD', domain: 'ISSUER', actionability: 'ISSUER_SIDE' },
  REJECTED_THREE_D_SECURE_REQUIRED: { status: 'DECLINED', declineType: 'SOFT', domain: 'AUTHENTICATION_3DS', actionability: 'ACTIONABLE' },
  REFER_TO_CARD_ISSUER: { status: 'DECLINED', declineType: 'SOFT', domain: 'ISSUER', actionability: 'ISSUER_SIDE' },
  REPORTED_LOST: { status: 'DECLINED', declineType: 'HARD', domain: 'ISSUER', actionability: 'ISSUER_SIDE' },
  REPORTED_STOLEN: { status: 'DECLINED', declineType: 'HARD', domain: 'ISSUER', actionability: 'ISSUER_SIDE' },
  REQUESTS_EXCEEDED: { status: 'DECLINED', declineType: 'SOFT', domain: 'PROVIDER', actionability: 'ACTIONABLE' },
  RESTRICTED_BY_BANK: { status: 'DECLINED', declineType: 'SOFT', domain: 'ISSUER', actionability: 'ISSUER_SIDE' },
  TERMINAL_ERROR: { status: 'DECLINED', declineType: 'SOFT', domain: 'PROVIDER_CONFIGURATION', actionability: 'ACTIONABLE' },
  THREE_D_SECURE_REQUIRED: { status: 'DECLINED', declineType: 'SOFT', domain: 'AUTHENTICATION_3DS', actionability: 'ACTIONABLE' },
  TRANSACTION_NOT_FOUND: { status: 'DECLINED', declineType: 'HARD', domain: 'PROVIDER', actionability: 'ACTIONABLE' },
  UNAVAILABLE_PAYMENT_METHOD: { status: 'DECLINED', declineType: 'HARD', domain: 'PROVIDER_CONFIGURATION', actionability: 'ACTIONABLE' },
  UNSUPPORTED_OPERATION: { status: 'DECLINED', declineType: 'HARD', domain: 'PROVIDER_CONFIGURATION', actionability: 'ACTIONABLE' },
  UNKNOWN_ERROR: { status: 'DECLINED', declineType: 'SOFT', domain: 'PROVIDER', actionability: 'LIMITED' },
  USER_RESTRICTION: { status: 'DECLINED', declineType: 'HARD', domain: 'ISSUER', actionability: 'ISSUER_SIDE' },

  // --- ERROR (oficial: lista propia, separada de DECLINED) ---
  ERROR: { status: 'ERROR', declineType: 'SOFT', domain: 'PROVIDER', actionability: 'LIMITED' },
  PROVIDER_ERROR: { status: 'ERROR', declineType: 'SOFT', domain: 'PROVIDER', actionability: 'LIMITED' },
  PROVIDER_INTERNAL_ERROR: { status: 'ERROR', declineType: 'SOFT', domain: 'PROVIDER', actionability: 'LIMITED' },
  PROVIDER_TIMEOUT: { status: 'ERROR', declineType: 'SOFT', domain: 'PROVIDER', actionability: 'LIMITED' },
  PROVIDER_UNKNOWN_ERROR: { status: 'ERROR', declineType: 'SOFT', domain: 'PROVIDER', actionability: 'LIMITED' },
  PROVIDER_INVALID_CREDENTIALS: { status: 'ERROR', declineType: 'HARD', domain: 'PROVIDER_CONFIGURATION', actionability: 'ACTIONABLE' },
  PROVIDER_INVALID_REQUEST: { status: 'ERROR', declineType: 'HARD', domain: 'PROVIDER_CONFIGURATION', actionability: 'ACTIONABLE' },
  PROVIDER_INVALID_RESPONSE: { status: 'ERROR', declineType: 'HARD', domain: 'PROVIDER', actionability: 'ACTIONABLE' },
  PROVIDER_INVALID_API_VERSION: { status: 'ERROR', declineType: 'HARD', domain: 'PROVIDER_CONFIGURATION', actionability: 'ACTIONABLE' },
  OPERATION_NOT_SUPPORTED: { status: 'ERROR', declineType: 'HARD', domain: 'PROVIDER_CONFIGURATION', actionability: 'ACTIONABLE' },
  TO_REVERSE: { status: 'ERROR', declineType: 'HARD', domain: 'PROVIDER', actionability: 'LIMITED' },

  // --- REJECTED (oficial: pre-proveedor, todos HARD) ---
  INVALID_REQUEST: { status: 'REJECTED', declineType: 'HARD', domain: 'PRE_PROVIDER', actionability: 'ACTIONABLE' },
  INTERNAL_ERROR: { status: 'REJECTED', declineType: 'HARD', domain: 'PRE_PROVIDER', actionability: 'ACTIONABLE' },
};

/**
 * Codigos que Yuno publica bajo el status REJECTED. Se guardan aparte porque
 * varios de ellos tambien existen bajo DECLINED con el mismo HARD/SOFT: lo que
 * cambia es el DOMINIO (pre-proveedor vs configuracion/datos).
 */
const REJECTED_CODES = new Set([
  'COUNTRY_NOT_SUPPORTED',
  'CURRENCY_NOT_ALLOWED',
  'INVALID_PARAMETERS',
  'INVALID_REQUEST',
  'INTERNAL_ERROR',
  'MISSING_PARAMETERS',
]);

export type TransactionClassification = {
  code: string;
  /** OFICIAL. Status al que pertenece el codigo. */
  transactionStatus: YunoTransactionStatus | 'UNKNOWN';
  /** OFICIAL. HARD/SOFT/N_A publicado por Yuno. */
  declineType: DeclineType;
  /** INFERIDO. Dominio logico del producto. */
  failureDomain: FailureDomain;
  /** INFERIDO. Quien puede intervenir. */
  actionability: Actionability;
  /** OFICIAL cuando viene MAC; agrupado por nosotros. */
  retryAdvice: RetryAdvice;
  /** true si el codigo no esta en la tabla publicada. */
  unknownCode: boolean;
};

/**
 * Clasifica un response_code, opcionalmente con el status real de la
 * transaccion y su Merchant Advice Code.
 *
 * Un codigo desconocido NUNCA se descarta: devuelve UNKNOWN en los campos
 * inferidos y `unknownCode: true`, para que aguas arriba se pueda decidir.
 */
export function classifyTransaction(input: {
  responseCode?: string | null;
  transactionStatus?: string | null;
  merchantAdviceCode?: string | null;
}): TransactionClassification | null {
  const raw = input.responseCode?.trim().toUpperCase();
  if (!raw) return null;

  const status = input.transactionStatus?.trim().toUpperCase();
  const retryAdvice = adviceFromMerchantAdviceCode(input.merchantAdviceCode);

  // El status real manda sobre la tabla: el mismo codigo significa cosas
  // distintas si Yuno lo rechazo antes de llegar al proveedor.
  if (status === 'REJECTED' && REJECTED_CODES.has(raw)) {
    return {
      code: raw,
      transactionStatus: 'REJECTED',
      declineType: 'HARD',
      failureDomain: 'PRE_PROVIDER',
      actionability: 'ACTIONABLE',
      retryAdvice,
      unknownCode: false,
    };
  }

  const entry = CODES[raw];
  if (!entry) {
    return {
      code: raw,
      transactionStatus: (status as YunoTransactionStatus) ?? 'UNKNOWN',
      declineType: 'UNKNOWN',
      failureDomain: 'UNKNOWN',
      actionability: 'UNKNOWN',
      retryAdvice,
      unknownCode: true,
    };
  }

  return {
    code: raw,
    transactionStatus: (status as YunoTransactionStatus) ?? entry.status,
    declineType: entry.declineType,
    failureDomain: entry.domain,
    actionability: entry.actionability,
    retryAdvice,
    unknownCode: false,
  };
}

export function isFailureStatus(status?: string | null): boolean {
  const value = status?.trim().toUpperCase();
  return value === 'DECLINED' || value === 'ERROR' || value === 'REJECTED';
}

/**
 * Puente con el status canonico interno del proyecto.
 *
 * Nuestro `PaymentStatus` tiene TIMEOUT, que NO es un transaction status de
 * Yuno: un timeout es `status = ERROR` con `response_code = PROVIDER_TIMEOUT`.
 * Se conserva TIMEOUT porque Detection, Analytics y Alerts ya dependen de el,
 * pero aqui queda documentado el mapeo real.
 */
export function canonicalToYunoStatus(canonical: string): YunoTransactionStatus {
  switch (canonical) {
    case 'APPROVED':
      return 'SUCCEEDED';
    case 'DECLINED':
      return 'DECLINED';
    case 'TIMEOUT':
      return 'ERROR';
    case 'ERROR':
    default:
      return 'ERROR';
  }
}

export function yunoStatusToCanonical(
  status: string,
  responseCode?: string | null,
): 'APPROVED' | 'DECLINED' | 'ERROR' | 'TIMEOUT' {
  const value = status.trim().toUpperCase();
  if (value === 'SUCCEEDED') return 'APPROVED';
  if (value === 'DECLINED') return 'DECLINED';
  if (value === 'ERROR') {
    return responseCode?.trim().toUpperCase() === 'PROVIDER_TIMEOUT' ? 'TIMEOUT' : 'ERROR';
  }
  // REJECTED es pre-proveedor: no hubo autorizacion, cuenta como intento fallido.
  return 'ERROR';
}
