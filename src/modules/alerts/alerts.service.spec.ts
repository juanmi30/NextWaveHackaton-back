import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { AlertsService, type AlertContext, type IncidentAlert } from './alerts.service.js';

describe('AlertsService English presentation', () => {
  it('builds English alert text from structured incident data instead of legacy copy', () => {
    const service = new AlertsService({ get: vi.fn(() => 'https://app.example.test') } as unknown as ConfigService);
    const incident: IncidentAlert = {
      id: 'incident-1',
      fingerprint: 'country=CO|failureReason=EXPIRED_CARD|merchant=Nova Travel',
      anchorFingerprint: 'merchant=Nova Travel',
      severity: 4,
      expectedApprovals: 131,
      actualApprovals: 0,
      lostApprovals: 131,
      averageTicketCents: 10_000,
      lossPerMinuteCents: 707_400,
      startedAt: new Date('2026-08-30T10:15:00.000Z'),
      detectedAt: new Date('2026-08-30T10:20:00.000Z'),
      summaryOps: 'Caída de aprobación.',
      summaryExec: 'Incidente activo.',
      recommendation: 'Revisar el incidente.',
      diagnoses: [{
        version: 1,
        dimensions: { country: 'CO', failureReason: 'EXPIRED_CARD', merchant: 'Nova Travel' },
        baselineRate: 0.943,
        observedRate: 0,
        baselineAttempts: 70,
        observedAttempts: 131,
        confidence: 0.84,
      }],
    };
    const context: AlertContext = {
      level: 1,
      levelLabel: 'Responsible specialist',
      totalLevels: 3,
      role: 'PAYMENTS_OPS',
      recipientName: 'Payments Ops',
      routingReason: 'The degradation requires operational review.',
    };

    const message = service.buildMessage(incident, context);

    expect(message.text).toContain('Estimated payment volume at risk');
    expect(message.text).toContain('EXPIRED_CARD');
    expect(message.html).toContain('lang="en"');
    expect(message.html).toContain('Payment volume at risk/min');
    expect(JSON.stringify(message)).not.toMatch(/caída|incidente activo|revisar|hola|impacto/iu);
  });
});
