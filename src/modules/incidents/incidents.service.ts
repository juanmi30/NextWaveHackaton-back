import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { QueryIncidentsDto } from './dto/query-incidents.dto.js';

@Injectable()
export class IncidentsService {
  constructor(private readonly prisma: PrismaService) {}

  findAll(query: QueryIncidentsDto) {
    return this.prisma.incident.findMany({
      where: query.status ? { status: query.status } : undefined,
      orderBy: { detectedAt: 'desc' },
      take: query.limit ?? 50,
    });
  }

  async acknowledge(id: string) {
    await this.ensureExists(id);
    return this.prisma.incident.update({
      where: { id },
      data: { status: 'ACKNOWLEDGED' },
    });
  }

  async resolve(id: string) {
    await this.ensureExists(id);
    return this.prisma.incident.update({
      where: { id },
      data: { status: 'RESOLVED', resolvedAt: new Date() },
    });
  }

  private async ensureExists(id: string) {
    const incident = await this.prisma.incident.findUnique({ where: { id }, select: { id: true } });
    if (!incident) throw new NotFoundException(`Incident ${id} not found`);
  }
}
