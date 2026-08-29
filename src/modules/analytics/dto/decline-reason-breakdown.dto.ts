import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class DeclineReasonBreakdownDto {
  @IsOptional() @IsString() merchant?: string;
  @IsOptional() @IsString() provider?: string;
  @IsOptional() @IsString() method?: string;
  @IsOptional() @IsString() country?: string;
  @IsOptional() @IsString() issuingBank?: string;

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
  minSampleSize?: number = 1;
}
