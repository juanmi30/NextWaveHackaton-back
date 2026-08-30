import { IsOptional, IsString } from 'class-validator';

export class AcknowledgeAlertDto {
  /** Quien acusa recibo. Opcional para no bloquear la demo. */
  @IsOptional()
  @IsString()
  recipientId?: string;
}
