import {
  IsOptional,
  IsString,
} from 'class-validator';

export class EvaluateSegmentDto {
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