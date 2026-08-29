import { Controller, Get, Param } from '@nestjs/common';
import { GraphService } from './graph.service.js';

@Controller('incidents')
export class GraphController {
  constructor(private readonly graph: GraphService) {}

  @Get(':id/graph')
  getIncidentGraph(@Param('id') id: string) {
    return this.graph.getIncidentGraph(id);
  }
}