import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

export const INCIDENT_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED'] as const;
export type IncidentStatusValue = (typeof INCIDENT_STATUSES)[number];

export class QueryIncidentsDto {
  @IsOptional()
  @IsIn(INCIDENT_STATUSES)
  status?: IncidentStatusValue;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(5)
  minSeverity?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number = 50;
}
