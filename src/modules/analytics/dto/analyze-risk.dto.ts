import { Transform, Type, type TransformFnParams } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export const ANALYSIS_DIMENSIONS = [
  'merchant',
  'provider',
  'method',
  'country',
  'issuingBank',
  'route',
] as const;
export type AnalysisDimension = (typeof ANALYSIS_DIMENSIONS)[number];

export class AnalyzeRiskDto {
  @IsOptional()
  @IsIn(ANALYSIS_DIMENSIONS)
  groupBy?: AnalysisDimension = 'route';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(1440)
  timeWindowMinutes?: number = 60;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(720)
  baselineHours?: number = 24;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  minSampleSize?: number = 10;

  @IsOptional()
  @Transform(({ value }: TransformFnParams) => value === true || value === 'true')
  @IsBoolean()
  includeLowRisk?: boolean = false;

  @IsOptional()
  @IsString()
  merchant?: string;

  @IsOptional()
  @IsString()
  provider?: string;

  @IsOptional()
  @IsString()
  method?: string;

  @IsOptional()
  @IsString()
  country?: string;

  @IsOptional()
  @IsString()
  issuingBank?: string;
}
