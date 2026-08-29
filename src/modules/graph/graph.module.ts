import { Module } from '@nestjs/common';
import { IncidentsModule } from '../incidents/incidents.module.js';
import { GraphController } from './graph.controller.js';
import { GraphService } from './graph.service.js';

@Module({
  imports: [IncidentsModule],
  controllers: [GraphController],
  providers: [GraphService],
})
export class GraphModule {}