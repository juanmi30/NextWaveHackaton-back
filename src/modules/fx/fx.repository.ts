import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';

@Injectable()
export class FxRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Tasa vigente: la mas reciente con fecha <= la pedida.
   * Este fallback es obligatorio; sin el, una fecha sin tasa exacta
   * deja el impacto economico en cero justo en la vista ejecutiva.
   */
  findEffective(currency: string, date: Date) {
    return this.prisma.fxRate.findFirst({
      where: { currency, rateDate: { lte: date } },
      orderBy: { rateDate: 'desc' },
    });
  }

  findAll() {
    return this.prisma.fxRate.findMany({ orderBy: [{ currency: 'asc' }, { rateDate: 'desc' }] });
  }

  upsert(currency: string, rateDate: Date, usdPerUnit: number, source?: string) {
    return this.prisma.fxRate.upsert({
      where: { currency_rateDate: { currency, rateDate } },
      create: { currency, rateDate, usdPerUnit, source },
      update: { usdPerUnit, source },
    });
  }

  count() {
    return this.prisma.fxRate.count();
  }
}
