import type { DimensionMap } from '../../common/dimensions.js';

export type LiveMonitorState = 'STOPPED' | 'RUNNING';

export type LiveConfig = {
  tickIntervalMs: number;
  transactionsPerTick: number;
  detectionIntervalMs: number;
  detectionWindowMinutes: number;
  randomSeed: number;
};

export type LiveDegradation = {
  id: string;
  dimensions: DimensionMap;
  approvalRate: number;
  failureReason: string;
  targetTransactionsPerTick: number;
  startedAt: string;
  expiresAt: string;
  status: 'ACTIVE';
};

export type LiveEvent = {
  type: string;
  timestamp: string;
  [key: string]: unknown;
};
