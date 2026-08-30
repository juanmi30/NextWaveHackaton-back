import { describe, expect, it } from 'vitest';
import {
  V2_FEATURES,
  aggregateYunoBucket,
  buildFeatureVectorV2,
  resolveResponseCode,
  type YunoTransactionRow,
} from './feature-vector-v2.js';
import { buildYunoFailureContext } from './yuno-failure-context.js';

const at = new Date('2026-08-30T18:00:00Z');

function tx(partial: Partial<YunoTransactionRow>): YunoTransactionRow {
  return { status: 'APPROVED', occurredAt: at, latencyMs: 400, ...partial };
}

describe('resolveResponseCode', () => {
  it('usa responseCode cuando existe', () => {
    expect(resolveResponseCode(tx({ responseCode: 'DO_NOT_HONOR' }))).toBe('DO_NOT_HONOR');
  });

  it('cae a los campos antiguos para transacciones previas a la migracion', () => {
    expect(resolveResponseCode(tx({ status: 'DECLINED', declineCode: 'INSUFFICIENT_FUNDS' })))
      .toBe('INSUFFICIENT_FUNDS');
    expect(resolveResponseCode(tx({ status: 'TIMEOUT' }))).toBe('PROVIDER_TIMEOUT');
  });
});

describe('aggregateYunoBucket', () => {
  it('separa los fallos por dominio logico', () => {
    const bucket = aggregateYunoBucket([
      ...Array.from({ length: 6 }, () => tx({})),
      tx({ status: 'DECLINED', responseCode: 'DO_NOT_HONOR', yunoStatus: 'DECLINED' }),
      tx({ status: 'DECLINED', responseCode: 'INVALID_SECURITY_CODE', yunoStatus: 'DECLINED' }),
      tx({ status: 'ERROR', responseCode: 'PROVIDER_TIMEOUT', yunoStatus: 'ERROR' }),
      tx({ status: 'ERROR', responseCode: 'INVALID_PARAMETERS', yunoStatus: 'REJECTED' }),
    ]);

    expect(bucket.attempts).toBe(10);
    expect(bucket.approvalRate).toBeCloseTo(0.6);
    expect(bucket.issuerDeclineRate).toBeCloseTo(0.1);
    expect(bucket.dataQualityFailureRate).toBeCloseTo(0.1);
    expect(bucket.providerTimeoutRate).toBeCloseTo(0.1);
    expect(bucket.rejectedRate).toBeCloseTo(0.1);
  });

  it('hard_decline_share se calcula sobre los FALLOS, no sobre los intentos', () => {
    const bucket = aggregateYunoBucket([
      tx({}),
      tx({ status: 'DECLINED', responseCode: 'EXPIRED_CARD', yunoStatus: 'DECLINED' }),
      tx({ status: 'DECLINED', responseCode: 'DO_NOT_HONOR', yunoStatus: 'DECLINED' }),
    ]);
    expect(bucket.hardDeclineShare).toBeCloseTo(0.5);
  });

  it('un bucket vacio no explota', () => {
    expect(aggregateYunoBucket([]).attempts).toBe(0);
  });

  it('el volumen bajo no inventa fallos: es solo menos evidencia', () => {
    const bucket = aggregateYunoBucket([tx({}), tx({})]);
    expect(bucket.approvalRate).toBe(1);
    expect(bucket.providerErrorRate).toBe(0);
  });
});

describe('buildFeatureVectorV2', () => {
  const buckets = [
    aggregateYunoBucket([tx({}), tx({}), tx({ status: 'DECLINED', responseCode: 'DO_NOT_HONOR' })]),
    aggregateYunoBucket([tx({}), tx({}), tx({ status: 'DECLINED', responseCode: 'DO_NOT_HONOR' })]),
    aggregateYunoBucket([tx({}), tx({ status: 'DECLINED', responseCode: 'DO_NOT_HONOR' }), tx({ status: 'ERROR', responseCode: 'PROVIDER_TIMEOUT', yunoStatus: 'ERROR' })]),
  ];

  it('devuelve exactamente las features del artefacto, sin sobrar ni faltar', () => {
    const vector = buildFeatureVectorV2({
      buckets,
      baselineApprovalRate: 0.9,
      anchor: at,
      timeZone: 'America/Bogota',
    });
    expect(Object.keys(vector).sort()).toEqual([...V2_FEATURES].sort());
  });

  it('la pendiente es (actual - mas_antiguo) / 2, igual que en Python', () => {
    const vector = buildFeatureVectorV2({
      buckets,
      baselineApprovalRate: 0.9,
      anchor: at,
      timeZone: 'UTC',
    });
    const expected = (buckets[2]!.approvalRate - buckets[0]!.approvalRate) / 2;
    expect(vector.approval_slope).toBeCloseTo(expected, 12);
  });

  it('el vector cambia con la zona horaria de la ruta', () => {
    const bogota = buildFeatureVectorV2({ buckets, baselineApprovalRate: 0.9, anchor: at, timeZone: 'America/Bogota' });
    const madrid = buildFeatureVectorV2({ buckets, baselineApprovalRate: 0.9, anchor: at, timeZone: 'Europe/Madrid' });
    expect(bogota.local_time_sin).not.toBeCloseTo(madrid.local_time_sin, 6);
    // El resto de senales operativas es identico.
    expect(bogota.approval_drop).toBeCloseTo(madrid.approval_drop, 12);
  });
});

describe('buildYunoFailureContext', () => {
  it('describe la ventana sin afirmar causalidad', () => {
    const context = buildYunoFailureContext([
      tx({}),
      tx({ status: 'DECLINED', responseCode: 'INSUFFICIENT_FUNDS', yunoStatus: 'DECLINED', merchantAdviceCode: 'RETRY_AFTER_24_H' }),
      tx({ status: 'DECLINED', responseCode: 'EXPIRED_CARD', yunoStatus: 'DECLINED' }),
      tx({ status: 'ERROR', responseCode: 'PROVIDER_TIMEOUT', yunoStatus: 'ERROR' }),
    ]);

    expect(context.totalAttempts).toBe(4);
    expect(context.totalFailures).toBe(3);
    expect(context.declineSemantics.hard).toBe(1);
    expect(context.declineSemantics.soft).toBe(2);
    expect(context.retryContext.RETRY_LATER).toBe(1);
    expect(context.actionability.issuerSide).toBe(1);
    expect(context.statusDistribution.map((d) => d.status)).toContain('ERROR');
    expect(context.domainDistribution.map((d) => d.domain)).toContain('PROVIDER');
  });

  it('senala los codigos que no estan en la taxonomia publicada', () => {
    const context = buildYunoFailureContext([
      tx({ status: 'DECLINED', responseCode: 'CODIGO_NUEVO_DE_YUNO', yunoStatus: 'DECLINED' }),
    ]);
    expect(context.unknownCodes).toEqual(['CODIGO_NUEVO_DE_YUNO']);
  });
});
