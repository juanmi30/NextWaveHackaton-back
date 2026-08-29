import { Injectable, Logger } from '@nestjs/common';
import { FxRepository } from './fx.repository.js';

/** Tasas de arranque. En produccion vendrian de un proveedor de FX. */
export const SEED_RATES: Record<string, number> = {
  USD: 1,
  COP: 0.00025,
  MXN: 0.055,
  BRL: 0.185,
  EUR: 1.08,
};

@Injectable()
export class FxService {
  private readonly logger = new Logger(FxService.name);
  private readonly cache = new Map<string, { id: string; usdPerUnit: number }>();

  constructor(private readonly repository: FxRepository) {}

  /**
   * Siembra las tasas base. Debe correr ANTES de insertar transacciones.
   *
   * Cubre un rango de dias hacia atras, no solo hoy: las transacciones del
   * seed estan fechadas en el pasado y `findEffective` busca la tasa mas
   * reciente con fecha <= la de la transaccion. Sembrar solo hoy deja todo
   * el historico sin tasa y el impacto economico sale mal.
   */
  async ensureSeeded(referenceDate = new Date(), daysBack = 45): Promise<number> {
    const today = startOfUtcDay(referenceDate);
    let written = 0;

    for (const [currency, base] of Object.entries(SEED_RATES)) {
      for (let offsetDays = daysBack; offsetDays >= 0; offsetDays--) {
        const day = new Date(today.getTime() - offsetDays * 86_400_000);
        const drift = currency === 'USD' ? 1 : 1 + Math.sin(offsetDays / 7) * 0.02;
        await this.repository.upsert(currency, day, base * drift, 'seed');
        written += 1;
      }
    }

    this.cache.clear();
    return written;
  }

  /**
   * Convierte a centavos de USD y devuelve la tasa aplicada, para poder
   * congelarla en la transaccion. Si no hay tasa, no revienta la ingesta:
   * registra el hueco y trata el monto como USD.
   */
  async convert(
    amountCents: number,
    currency: string,
    occurredAt: Date,
  ): Promise<{ amountUsdCents: number; fxRateId: string | null }> {
    const rate = await this.resolve(currency, occurredAt);
    if (!rate) {
      this.logger.warn(`Sin tasa FX para ${currency}; se asume paridad con USD`);
      return { amountUsdCents: amountCents, fxRateId: null };
    }
    return {
      amountUsdCents: Math.round(amountCents * rate.usdPerUnit),
      fxRateId: rate.id,
    };
  }

  private async resolve(currency: string, occurredAt: Date) {
    const key = `${currency}:${startOfUtcDay(occurredAt).toISOString()}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const row = await this.repository.findEffective(currency, occurredAt);
    if (!row) return null;

    const value = { id: row.id, usdPerUnit: Number(row.usdPerUnit) };
    this.cache.set(key, value);
    return value;
  }

  list() {
    return this.repository.findAll();
  }
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
