import { describe, expect, it } from 'vitest';
import { humanizeDimensions } from './dimensions.js';

describe('humanizeDimensions', () => {
  it('uses English labels while preserving machine and entity values', () => {
    const result = humanizeDimensions({
      merchant: 'Nova Travel',
      method: 'CARD',
      country: 'CO',
      failureReason: 'EXPIRED_CARD',
    });

    expect(result).toContain('merchant Nova Travel');
    expect(result).toContain('payment method CARD');
    expect(result).toContain('country CO');
    expect(result).toContain('decline reason EXPIRED_CARD');
    expect(result).not.toMatch(/comercio|método|país|motivo/iu);
  });
});
