import { Controller, Get, Query } from '@nestjs/common';
import { UnifiedGraphService } from './unified-graph.service.js';

@Controller('graph')
export class UnifiedGraphController {
  constructor(
    private readonly unifiedGraph: UnifiedGraphService,
  ) {}

  @Get('unified')
  getUnifiedGraph(
    @Query('incidentId') incidentId?: string,
  ) {
    return this.unifiedGraph.build({ incidentId });
  }
}