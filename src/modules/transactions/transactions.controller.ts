import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { BulkCreateTransactionsDto, CreateTransactionDto } from './dto/create-transaction.dto.js';
import { QueryTransactionsDto } from './dto/query-transactions.dto.js';
import { TransactionsService } from './transactions.service.js';

@Controller('transactions')
export class TransactionsController {
  constructor(private readonly transactions: TransactionsService) {}

  @Post()
  create(@Body() dto: CreateTransactionDto) {
    return this.transactions.create(dto);
  }

  @Post('bulk')
  createBulk(@Body() dto: BulkCreateTransactionsDto) {
    return this.transactions.createBulk(dto);
  }

  @Get()
  findAll(@Query() query: QueryTransactionsDto) {
    return this.transactions.findAll(query);
  }
}
