import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { AcknowledgeAlertDto } from '../alerts/dto/acknowledge-alert.dto.js';
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
  acknowledge(@Param('id') id: string, @Body() dto: AcknowledgeAlertDto) {
    return this.incidents.acknowledge(id, dto?.recipientId);
  }

  @Patch(':id/resolve')
  resolve(@Param('id') id: string) {
    return this.incidents.resolve(id);
  }
}
