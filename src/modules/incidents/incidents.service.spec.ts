import { describe, expect, it, vi } from 'vitest';
import { IncidentsService } from './incidents.service.js';
import type { IncidentsRepository } from './incidents.repository.js';
import type { EscalationService } from '../alerts/escalation.service.js';

/** El escalamiento no es el objeto de estas pruebas: se neutraliza. */
function escalationStub(): EscalationService {
  return {
    acknowledge: async () => undefined,
    close: async () => undefined,
  } as unknown as EscalationService;
}

const fingerprint = 'merchant=Mercado Uno|method=CARD|provider=Adyen';

function incident(
  id: string,
  status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED',
  currentFingerprint = fingerprint,
) {
  return {
    id,
    status,
    fingerprint: currentFingerprint,
    anchorFingerprint: 'method=CARD',
  };
}

function createService(previous: ReturnType<typeof incident>[]) {
  const repository = {
    findOne: vi.fn().mockResolvedValue(incident('current', 'OPEN')),
    findResolvedByFingerprint: vi.fn().mockResolvedValue(previous),
  };
  return {
    repository,
    service: new IncidentsService(repository as unknown as IncidentsRepository, escalationStub()),
  };
}

describe('IncidentsService.history', () => {
  it('marks a resolved incident with the same fingerprint as a recurrence', async () => {
    const previous = incident('previous', 'RESOLVED');
    const { service, repository } = createService([previous]);

    const result = await service.history('current');

    expect(repository.findResolvedByFingerprint).toHaveBeenCalledWith(fingerprint);
    expect(result).toEqual({
      anchorFingerprint: 'method=CARD',
      isRecurrence: true,
      previousOccurrences: [previous],
    });
  });

  it('rejects the same anchorFingerprint when the exact fingerprint differs', async () => {
    const unrelated = incident(
      'previous',
      'RESOLVED',
      'merchant=Nova Travel|method=CARD|provider=Stripe',
    );
    const { service } = createService([unrelated]);

    const result = await service.history('current');

    expect(result.isRecurrence).toBe(false);
    expect(result.previousOccurrences).toEqual([]);
  });

  it('rejects an open incident even when its fingerprint matches', async () => {
    const { service } = createService([incident('previous', 'OPEN')]);

    const result = await service.history('current');

    expect(result.isRecurrence).toBe(false);
    expect(result.previousOccurrences).toEqual([]);
  });

  it('returns no recurrence when there is no previous incident', async () => {
    const { service } = createService([]);

    const result = await service.history('current');

    expect(result.isRecurrence).toBe(false);
    expect(result.previousOccurrences).toEqual([]);
  });
});
