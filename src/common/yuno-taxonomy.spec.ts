import { describe, expect, it } from 'vitest';
import {
  adviceFromMerchantAdviceCode,
  canonicalToYunoStatus,
  classifyTransaction,
  yunoStatusToCanonical,
} from './yuno-taxonomy.js';

describe('classifyTransaction — HARD/SOFT oficial de Yuno', () => {
  it('EXPIRED_CARD es HARD y EXPIRED es SOFT (la v1 marcaba ambos HARD)', () => {
    expect(classifyTransaction({ responseCode: 'EXPIRED_CARD' })!.declineType).toBe('HARD');
    expect(classifyTransaction({ responseCode: 'EXPIRED' })!.declineType).toBe('SOFT');
  });

  it('los rechazos del emisor son SOFT segun la tabla publicada', () => {
    for (const code of ['INSUFFICIENT_FUNDS', 'DO_NOT_HONOR', 'DECLINED_BY_BANK', 'RESTRICTED_BY_BANK']) {
      expect(classifyTransaction({ responseCode: code })!.declineType).toBe('SOFT');
    }
  });

  it('REPORTED_LOST y REPORTED_STOLEN si son HARD', () => {
    expect(classifyTransaction({ responseCode: 'REPORTED_LOST' })!.declineType).toBe('HARD');
    expect(classifyTransaction({ responseCode: 'REPORTED_STOLEN' })!.declineType).toBe('HARD');
  });

  it('los HARD que faltaban en la v1', () => {
    for (const code of [
      'BAD_FILLED_INFO',
      'INVALID_PARAMETERS',
      'INVALID_TRANSACTION',
      'INVALID_API',
      'INVALID_CREDENTIALS',
      'TRANSACTION_NOT_FOUND',
      'UNAVAILABLE_PAYMENT_METHOD',
      'UNSUPPORTED_OPERATION',
      'USER_RESTRICTION',
      'RETRY_AFTER_24_H',
    ]) {
      expect(classifyTransaction({ responseCode: code })!.declineType).toBe('HARD');
    }
  });

  it('TERMINAL_ERROR y ACQUIRE_CONTINGENCY son SOFT', () => {
    expect(classifyTransaction({ responseCode: 'TERMINAL_ERROR' })!.declineType).toBe('SOFT');
    expect(classifyTransaction({ responseCode: 'ACQUIRE_CONTINGENCY' })!.declineType).toBe('SOFT');
  });
});

describe('classifyTransaction — separacion de statuses', () => {
  it('los codigos de ERROR son su propia familia, no declines', () => {
    const timeout = classifyTransaction({ responseCode: 'PROVIDER_TIMEOUT' })!;
    expect(timeout.transactionStatus).toBe('ERROR');
    expect(timeout.failureDomain).toBe('PROVIDER');
  });

  it('PROVIDER_INVALID_CREDENTIALS es ERROR + configuracion, no decline de emisor', () => {
    const c = classifyTransaction({ responseCode: 'PROVIDER_INVALID_CREDENTIALS' })!;
    expect(c.transactionStatus).toBe('ERROR');
    expect(c.declineType).toBe('HARD');
    expect(c.failureDomain).toBe('PROVIDER_CONFIGURATION');
    expect(c.actionability).toBe('ACTIONABLE');
  });

  it('preserva semantica canonica para routing y decline intelligence', () => {
    expect(classifyTransaction({ responseCode: 'DO_NOT_HONOR' })).toMatchObject({
      declineType: 'SOFT', failureDomain: 'ISSUER', actionability: 'ISSUER_SIDE',
    });
    expect(classifyTransaction({ responseCode: 'PROVIDER_TIMEOUT' })).toMatchObject({
      transactionStatus: 'ERROR', declineType: 'SOFT', failureDomain: 'PROVIDER',
    });
    expect(classifyTransaction({ responseCode: 'ISSUER_VIOLATION' })).toMatchObject({
      failureDomain: 'ISSUER', actionability: 'ISSUER_SIDE',
    });
  });

  it('el mismo codigo cambia de dominio segun el status real', () => {
    const declined = classifyTransaction({ responseCode: 'INVALID_PARAMETERS', transactionStatus: 'DECLINED' })!;
    const rejected = classifyTransaction({ responseCode: 'INVALID_PARAMETERS', transactionStatus: 'REJECTED' })!;
    expect(declined.failureDomain).toBe('MERCHANT_DATA');
    expect(rejected.failureDomain).toBe('PRE_PROVIDER');
    expect(rejected.declineType).toBe('HARD');
  });

  it('un codigo desconocido no se pierde: se marca y sigue', () => {
    const c = classifyTransaction({ responseCode: 'CODIGO_INEXISTENTE' })!;
    expect(c.unknownCode).toBe(true);
    expect(c.failureDomain).toBe('UNKNOWN');
    expect(c.declineType).toBe('UNKNOWN');
  });

  it('sin response code devuelve null', () => {
    expect(classifyTransaction({ responseCode: null })).toBeNull();
  });
});

describe('Merchant Advice Codes', () => {
  it('mapea la lista oficial a consejo operativo', () => {
    expect(adviceFromMerchantAdviceCode('DO_NOT_TRY_AGAIN')).toBe('DO_NOT_RETRY');
    expect(adviceFromMerchantAdviceCode('RETRY_AFTER_24_H')).toBe('RETRY_LATER');
    expect(adviceFromMerchantAdviceCode('TRY_AGAIN_LATER')).toBe('RETRY_LATER');
    expect(adviceFromMerchantAdviceCode('UPDATE_INFORMATION')).toBe('UPDATE_INFORMATION');
    expect(adviceFromMerchantAdviceCode('REQUIREMENTS_NOT_FULFILLED')).toBe('UPDATE_INFORMATION');
    expect(adviceFromMerchantAdviceCode(null)).toBe('UNKNOWN');
  });

  it('el MAC viaja junto a la clasificacion', () => {
    const c = classifyTransaction({
      responseCode: 'INSUFFICIENT_FUNDS',
      merchantAdviceCode: 'RETRY_AFTER_24_H',
    })!;
    expect(c.retryAdvice).toBe('RETRY_LATER');
  });
});

describe('puente con el status canonico interno', () => {
  it('TIMEOUT no existe en Yuno: es ERROR + PROVIDER_TIMEOUT', () => {
    expect(canonicalToYunoStatus('TIMEOUT')).toBe('ERROR');
    expect(yunoStatusToCanonical('ERROR', 'PROVIDER_TIMEOUT')).toBe('TIMEOUT');
    expect(yunoStatusToCanonical('ERROR', 'PROVIDER_ERROR')).toBe('ERROR');
  });

  it('el resto del mapeo es directo', () => {
    expect(canonicalToYunoStatus('APPROVED')).toBe('SUCCEEDED');
    expect(yunoStatusToCanonical('SUCCEEDED')).toBe('APPROVED');
    expect(yunoStatusToCanonical('DECLINED')).toBe('DECLINED');
    expect(yunoStatusToCanonical('REJECTED')).toBe('ERROR');
  });
});
