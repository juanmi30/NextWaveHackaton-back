import { Type } from 'class-transformer';
import { IsInt, IsString, Max, Min } from 'class-validator';

export class PreviewRoutingDto {
  /** Clave canonica del segmento, p. ej. "country=BR|failureReason=INVALID_CVV". */
  @IsString()
  fingerprint: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(5)
  severity: number;
}
