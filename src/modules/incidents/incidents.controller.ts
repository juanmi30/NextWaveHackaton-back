import { Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { QueryIncidentsDto } from './dto/query-incidents.dto.js';
import { IncidentsService } from './incidents.service.js';

@Controller('incidents')
export class IncidentsController {
  constructor(private readonly incidents: IncidentsService) {}

  @Get()
  findAll(@Query() query: QueryIncidentsDto) {
    return this.incidents.findAll(query);
  }

  @Get('stats')
  stats() {
    return this.incidents.countOpen();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.incidents.findOne(id);
  }

  @Get(':id/history')
  history(@Param('id') id: string) {
    return this.incidents.history(id);
  }

  @Patch(':id/acknowledge')
  acknowledge(@Param('id') id: string) {
    return this.incidents.acknowledge(id);
  }

  @Patch(':id/resolve')
  resolve(@Param('id') id: string) {
    return this.incidents.resolve(id);
  }
}
