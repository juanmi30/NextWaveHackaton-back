import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

export class StartLiveMonitorDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(250)
  @Max(60_000)
  tickIntervalMs?: number = 1_000;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  transactionsPerTick?: number = 50;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1_000)
  @Max(300_000)
  detectionIntervalMs?: number = 5_000;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(60)
  detectionWindowMinutes?: number = 5;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  randomSeed?: number = 1_337;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  autoSeed?: boolean = false;
}
