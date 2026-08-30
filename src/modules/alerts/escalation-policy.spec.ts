import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POLICIES,
  nextEscalationAt,
  rolesForStep,
  selectPolicy,
  stepAt,
} from './escalation-policy.js';

const openedAt = new Date('2026-08-29T18:00:00.000Z');

describe('selectPolicy', () => {
  it('elige la politica por severidad', () => {
    expect(selectPolicy(4).name).toBe('critical');
    expect(selectPolicy(3).name).toBe('high');
    expect(selectPolicy(1).name).toBe('standard');
  });

  it('nunca deja un incidente sin politica', () => {
    expect(selectPolicy(99).name).toBeTruthy();
    expect(selectPolicy(-1).name).toBeTruthy();
  });
});

describe('nextEscalationAt', () => {
  it('critico escala a los 5 y a los 15 minutos', () => {
    const policy = selectPolicy(4);
    expect(nextEscalationAt(policy, 1, openedAt)?.toISOString()).toBe('2026-08-29T18:05:00.000Z');
    expect(nextEscalationAt(policy, 2, openedAt)?.toISOString()).toBe('2026-08-29T18:15:00.000Z');
  });

  it('devuelve null cuando la politica se agota', () => {
    expect(nextEscalationAt(selectPolicy(4), 3, openedAt)).toBeNull();
    expect(nextEscalationAt(selectPolicy(1), 2, openedAt)).toBeNull();
  });

  it('los tiempos se acortan al subir la severidad', () => {
    const critico = nextEscalationAt(selectPolicy(4), 1, openedAt)!.getTime();
    const alto = nextEscalationAt(selectPolicy(3), 1, openedAt)!.getTime();
    const normal = nextEscalationAt(selectPolicy(1), 1, openedAt)!.getTime();
    expect(critico).toBeLessThan(alto);
    expect(alto).toBeLessThan(normal);
  });
});

describe('rolesForStep', () => {
  it('combina los roles fijos del nivel con los del diagnostico', () => {
    const step = stepAt(selectPolicy(4), 2)!;
    const roles = rolesForStep(step, ['CHECKOUT_ENGINEER']);
    expect(roles).toContain('ADMIN');
    expect(roles).toContain('CHECKOUT_ENGINEER');
  });

  it('no duplica un rol presente en ambos lados', () => {
    const step = stepAt(selectPolicy(4), 1)!;
    const roles = rolesForStep(step, ['PAYMENTS_OPS']);
    expect(roles.filter((role) => role === 'PAYMENTS_OPS')).toHaveLength(1);
  });
});

describe('estructura de las politicas', () => {
  it('todas escalan de menor a mayor espera', () => {
    for (const policy of DEFAULT_POLICIES) {
      const waits = policy.steps.map((step) => step.waitMinutes);
      expect([...waits].sort((a, b) => a - b)).toEqual(waits);
      expect(policy.steps[0]?.waitMinutes).toBe(0);
    }
  });

  it('todas terminan avisando a alguien por encima del especialista', () => {
    for (const policy of DEFAULT_POLICIES) {
      const last = policy.steps[policy.steps.length - 1]!;
      expect(last.roles.length).toBeGreaterThan(0);
    }
  });
});
