import { Transform, Type, type TransformFnParams } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { DIMENSIONS } from '../../../common/dimensions.js';

export const ANALYSIS_DIMENSIONS = [...DIMENSIONS, 'route'] as const;
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
  @IsDateString()
  asOf?: string | Date;

  @IsOptional() @IsString() merchant?: string;
  @IsOptional() @IsString() provider?: string;
  @IsOptional() @IsString() method?: string;
  @IsOptional() @IsString() country?: string;
  @IsOptional() @IsString() issuingBank?: string;
  @IsOptional() @IsString() failureReason?: string;
}
