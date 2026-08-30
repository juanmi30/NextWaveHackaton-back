import { describe, expect, it } from 'vitest';
import { coversScope, routeIncident, scopeFromFingerprint } from './routing.js';

describe('routeIncident', () => {
  it('manda los datos mal formados del checkout al equipo de checkout', () => {
    const decision = routeIncident({ failureReason: 'INVALID_SECURITY_CODE' }, 2);
    expect(decision.category).toBe('DATA_QUALITY');
    expect(decision.roles).toEqual(['CHECKOUT_ENGINEER']);
  });

  it('manda credenciales invalidas a integraciones y al responsable del proveedor', () => {
    const decision = routeIncident({ failureReason: 'INVALID_CREDENTIALS', provider: 'dLocal' }, 2);
    expect(decision.category).toBe('PROVIDER_CONFIGURATION');
    expect(decision.roles).toEqual(['INTEGRATIONS_ENGINEER', 'PROVIDER_MANAGER']);
  });

  it('trata el rechazo del emisor como informativo, no accionable', () => {
    const decision = routeIncident({ failureReason: 'DO_NOT_HONOR' }, 2);
    expect(decision.actionability).toBe('ISSUER_SIDE');
    expect(decision.roles).toEqual(['MERCHANT_SUCCESS']);
    expect(decision.reason).toContain('No es accionable desde Yuno');
  });

  it('routes ISSUER_VIOLATION as issuer-side, never provider configuration', () => {
    const decision = routeIncident({ failureReason: 'ISSUER_VIOLATION' }, 2);
    expect(decision.category).toBe('ISSUER_DECLINE');
    expect(decision.actionability).toBe('ISSUER_SIDE');
    expect(decision.roles).toEqual(['MERCHANT_SUCCESS']);
  });

  it('routes provider timeout to integration ownership', () => {
    expect(routeIncident({ failureReason: 'PROVIDER_TIMEOUT' }, 2).roles)
      .toEqual(['INTEGRATIONS_ENGINEER']);
  });

  it('routes canonical provider credentials to provider configuration owners', () => {
    expect(routeIncident({ failureReason: 'PROVIDER_INVALID_CREDENTIALS' }, 2).roles)
      .toEqual(['INTEGRATIONS_ENGINEER', 'PROVIDER_MANAGER']);
  });

  it('manda el fraude a riesgo', () => {
    expect(routeIncident({ failureReason: 'FRAUD_VALIDATION' }, 2).roles).toEqual(['RISK_ANALYST']);
  });

  it('un codigo desconocido no se pierde: cae en la guardia general', () => {
    const decision = routeIncident({ failureReason: 'CODIGO_QUE_NADIE_HA_VISTO' }, 2);
    expect(decision.category).toBe('UNKNOWN');
    expect(decision.roles).toEqual(['PAYMENTS_OPS']);
  });

  it('sin motivo concentrado lo trata como caida transversal', () => {
    const decision = routeIncident({ provider: 'Adyen', country: 'BR' }, 2);
    expect(decision.category).toBe('NO_CONCENTRATED_REASON');
    expect(decision.roles).toEqual(['PAYMENTS_OPS']);
  });

  it('desde severidad 3 la guardia general entra junto al especialista', () => {
    const low = routeIncident({ failureReason: 'INVALID_SECURITY_CODE' }, 2);
    const high = routeIncident({ failureReason: 'INVALID_SECURITY_CODE' }, 3);
    expect(low.roles).not.toContain('PAYMENTS_OPS');
    expect(high.roles).toEqual(['CHECKOUT_ENGINEER', 'PAYMENTS_OPS']);
  });
});

describe('coversScope', () => {
  const global = { merchants: [], providers: [], countries: [] };
  const brasil = { merchants: [], providers: [], countries: ['BR'] };

  it('un alcance vacio cubre todo', () => {
    expect(coversScope(global, { country: 'MX', provider: 'Stripe' })).toBe(true);
  });

  it('excluye cuando el incidente fija una dimension con otro valor', () => {
    expect(coversScope(brasil, { country: 'MX' })).toBe(false);
    expect(coversScope(brasil, { country: 'BR' })).toBe(true);
  });

  it('no excluye cuando el incidente no fija esa dimension', () => {
    expect(coversScope(brasil, { provider: 'Adyen' })).toBe(true);
  });
});

describe('scopeFromFingerprint', () => {
  it('parsea la clave canonica', () => {
    expect(scopeFromFingerprint('country=BR|failureReason=INVALID_CVV|provider=dLocal')).toEqual({
      country: 'BR',
      failureReason: 'INVALID_CVV',
      provider: 'dLocal',
    });
  });

  it('ignora fragmentos malformados', () => {
    expect(scopeFromFingerprint('basura|country=CO')).toEqual({ country: 'CO' });
  });
});
