import { Type } from 'class-transformer';
import {
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

class LiveDimensionsDto {
  @IsOptional() @IsString() merchant?: string;
  @IsOptional() @IsString() provider?: string;
  @IsOptional() @IsString() method?: string;
  @IsOptional() @IsString() country?: string;
  @IsOptional() @IsString() issuingBank?: string;
}

export class CreateLiveDegradationDto {
  @IsObject()
  @ValidateNested()
  @Type(() => LiveDimensionsDto)
  dimensions: LiveDimensionsDto;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  approvalRate: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3_600)
  durationSeconds?: number = 60;

  @IsOptional()
  @IsString()
  failureReason?: string = 'DO_NOT_HONOR';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(250)
  targetTransactionsPerTick?: number = 20;
}
