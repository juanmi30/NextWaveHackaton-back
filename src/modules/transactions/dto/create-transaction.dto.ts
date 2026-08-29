import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export const PAYMENT_STATUSES = ['APPROVED', 'DECLINED', 'ERROR', 'TIMEOUT'] as const;
export type PaymentStatusValue = (typeof PAYMENT_STATUSES)[number];

export class CreateTransactionDto {
  @IsOptional()
  @IsString()
  externalId?: string;

  @IsString()
  @IsNotEmpty()
  merchant: string;

  @IsString()
  @IsNotEmpty()
  provider: string;

  @IsString()
  @IsNotEmpty()
  method: string;

  @IsString()
  @IsNotEmpty()
  country: string;

  @IsString()
  @IsNotEmpty()
  issuingBank: string;

  @IsIn(PAYMENT_STATUSES)
  status: PaymentStatusValue;

  @IsOptional()
  @IsString()
  declineCode?: string;

  @IsOptional()
  @IsString()
  errorType?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  latencyMs?: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  amountCents: number;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsDateString()
  occurredAt?: string;
}

export class BulkCreateTransactionsDto {
  @IsArray()
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => CreateTransactionDto)
  transactions: CreateTransactionDto[];
}
