import { IsNumber } from 'class-validator';

export class EvaluatePredictionDto {
  @IsNumber()
  baselineApprovalRate: number;

  @IsNumber()
  approvalDrop: number;

  @IsNumber()
  approvalSlope: number;

  @IsNumber()
  timeoutRate: number;

  @IsNumber()
  timeoutSlope: number;

  @IsNumber()
  errorRate: number;

  @IsNumber()
  p95LatencyMs: number;

  @IsNumber()
  latencySlope: number;
}