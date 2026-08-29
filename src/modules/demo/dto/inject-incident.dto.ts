import { Type } from 'class-transformer';
import { IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * Prueba de fuego. Los jueces eligen CUALQUIER combinacion de dimensiones
 * y una tasa de aprobacion degradada. No hay escenarios precargados:
 * si la combinacion no existe todavia, se crea sobre la marcha.
 */
export class InjectIncidentDto {
  @IsOptional() @IsString() merchant?: string;
  @IsOptional() @IsString() provider?: string;
  @IsOptional() @IsString() method?: string;
  @IsOptional() @IsString() country?: string;
  @IsOptional() @IsString() issuingBank?: string;

  @IsOptional() @IsString() declineCode?: string;
  @IsOptional() @IsString() errorType?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  approvalRate?: number = 0.35;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(240)
  durationMinutes?: number = 15;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  transactionsPerMinute?: number = 12;
}
