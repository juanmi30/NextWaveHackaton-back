import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { IncidentsService } from '../incidents/incidents.service.js';
import type { AnalysisDimension, AnalyzeRiskDto } from './dto/analyze-risk.dto.js';

type Tx = {
  merchant: string;
  provider: string;
  method: string;
  country: string;
  issuingBank: string;
  status: string;
  amountCents: number;
  latencyMs: number | null;
  occurredAt: Date;
};

type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

type WindowMetrics = {
  total: number;
  approved: number;
  declined: number;
  errors: number;
  timeouts: number;
  approvalRate: number;
  failureRate: number;
  p95LatencyMs: number | null;
  averageAmountCents: number;
};

type MetricsTx = Pick<Tx, 'status' | 'amountCents' | 'latencyMs'>;

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly incidents: IncidentsService,
  ) {}

  async summary() {
    const [transactions, incidents] = await Promise.all([
      this.prisma.transaction.findMany({
        select: { status: true, amountCents: true, latencyMs: true },
      }),
      this.incidents.countOpen(),
    ]);
    const metrics = this.metrics(transactions);

    return {
      transactionCount: metrics.total,
      approvalRate: metrics.approvalRate,
      failureRate: metrics.failureRate,
      openIncidentCount: incidents.open,
      highCriticalIncidentCount: incidents.highCritical,
    };
  }

  async analyze(dto: AnalyzeRiskDto) {
    const groupBy = dto.groupBy ?? 'route';
    const windowMinutes = dto.timeWindowMinutes ?? 60;
    const baselineHours = dto.baselineHours ?? 24;
    const minSampleSize = dto.minSampleSize ?? 10;
    const now = new Date();
    const currentStart = new Date(now.getTime() - windowMinutes * 60_000);
    const baselineStart = new Date(currentStart.getTime() - baselineHours * 3_600_000);

    const transactions = (await this.prisma.transaction.findMany({
      where: {
        occurredAt: { gte: baselineStart, lte: now },
        ...(dto.merchant ? { merchant: dto.merchant } : {}),
        ...(dto.provider ? { provider: dto.provider } : {}),
        ...(dto.method ? { method: dto.method } : {}),
        ...(dto.country ? { country: dto.country } : {}),
        ...(dto.issuingBank ? { issuingBank: dto.issuingBank } : {}),
      },
      orderBy: { occurredAt: 'asc' },
    })) as Tx[];

    const current = transactions.filter((tx) => tx.occurredAt >= currentStart);
    const baseline = transactions.filter((tx) => tx.occurredAt < currentStart);
    const currentGroups = this.group(current, groupBy);
    const baselineGroups = this.group(baseline, groupBy);

    const risks = [...currentGroups.entries()]
      .filter(([, txs]) => txs.length >= minSampleSize)
      .map(([key, txs]) => {
        const currentMetrics = this.metrics(txs);
        const baselineMetrics = this.metrics(baselineGroups.get(key) ?? []);
        return this.score(groupBy, key, txs[0], currentMetrics, baselineMetrics);
      })
      .filter((risk) => dto.includeLowRisk || risk.riskLevel !== 'LOW')
      .sort((a, b) => b.score - a.score);

    return {
      config: { groupBy, windowMinutes, baselineHours, minSampleSize },
      windows: {
        baseline: { from: baselineStart, to: currentStart },
        current: { from: currentStart, to: now },
      },
      summary: {
        transactionsAnalyzed: transactions.length,
        currentTransactions: current.length,
        baselineTransactions: baseline.length,
        entitiesAnalyzed: risks.length,
        critical: risks.filter((x) => x.riskLevel === 'CRITICAL').length,
        high: risks.filter((x) => x.riskLevel === 'HIGH').length,
        medium: risks.filter((x) => x.riskLevel === 'MEDIUM').length,
      },
      risks,
    };
  }

  async detect(dto: AnalyzeRiskDto) {
    const analysis = await this.analyze({ ...dto, includeLowRisk: false });
    const actionable = analysis.risks.filter(
      (risk) => risk.riskLevel === 'HIGH' || risk.riskLevel === 'CRITICAL',
    );

    const incidents = [];
    for (const risk of actionable) {
      const incident = await this.prisma.incident.create({
        data: {
          title: `${risk.riskLevel}: caída de aprobación en ${risk.label}`,
          dimensions: risk.dimensions,
          severity: risk.riskLevel === 'CRITICAL' ? 4 : 3,
          baselineRate: risk.baseline.approvalRate,
          observedRate: risk.current.approvalRate,
          estimatedLoss: risk.estimatedLossCents,
          evidence: {
            score: risk.score,
            confidence: risk.confidence,
            signals: risk.signals,
            current: risk.current,
            baseline: risk.baseline,
          },
          recommendation: risk.recommendation,
        },
      });
      incidents.push(incident);
    }

    return { analysis, incidentsCreated: incidents.length, incidents };
  }

  private group(transactions: Tx[], dimension: AnalysisDimension) {
    const groups = new Map<string, Tx[]>();
    for (const tx of transactions) {
      const key = this.key(tx, dimension);
      const bucket = groups.get(key) ?? [];
      bucket.push(tx);
      groups.set(key, bucket);
    }
    return groups;
  }

  private key(tx: Tx, dimension: AnalysisDimension) {
    switch (dimension) {
      case 'merchant':
        return tx.merchant;
      case 'provider':
        return tx.provider;
      case 'method':
        return tx.method;
      case 'country':
        return tx.country;
      case 'issuingBank':
        return tx.issuingBank;
      case 'route':
        return [tx.merchant, tx.provider, tx.method, tx.country, tx.issuingBank].join('|');
    }
  }

  private metrics(transactions: MetricsTx[]): WindowMetrics {
    const total = transactions.length;
    const approved = transactions.filter((tx) => tx.status === 'APPROVED').length;
    const declined = transactions.filter((tx) => tx.status === 'DECLINED').length;
    const errors = transactions.filter((tx) => tx.status === 'ERROR').length;
    const timeouts = transactions.filter((tx) => tx.status === 'TIMEOUT').length;
    const latencies = transactions
      .map((tx) => tx.latencyMs)
      .filter((value): value is number => value !== null)
      .sort((a, b) => a - b);
    const p95Index = Math.max(0, Math.ceil(latencies.length * 0.95) - 1);
    const averageAmountCents = total
      ? Math.round(transactions.reduce((sum, tx) => sum + tx.amountCents, 0) / total)
      : 0;

    return {
      total,
      approved,
      declined,
      errors,
      timeouts,
      approvalRate: total ? approved / total : 0,
      failureRate: total ? (declined + errors + timeouts) / total : 0,
      p95LatencyMs: latencies.length ? latencies[p95Index] : null,
      averageAmountCents,
    };
  }

  private score(
    dimension: AnalysisDimension,
    key: string,
    sample: Tx,
    current: WindowMetrics,
    baseline: WindowMetrics,
  ) {
    const approvalDrop = Math.max(0, baseline.approvalRate - current.approvalRate);
    const failureIncrease = Math.max(0, current.failureRate - baseline.failureRate);
    const latencySignal = current.p95LatencyMs === null ? null : this.clamp(current.p95LatencyMs / 5_000);

    const signals = [
      { name: 'failure_rate', value: current.failureRate, normalized: this.clamp(current.failureRate / 0.5), weight: 0.35 },
      { name: 'approval_drop', value: approvalDrop, normalized: this.clamp(approvalDrop / 0.25), weight: 0.35 },
      { name: 'failure_trend', value: failureIncrease, normalized: this.clamp(failureIncrease / 0.25), weight: 0.2 },
      ...(latencySignal === null
        ? []
        : [{ name: 'p95_latency', value: current.p95LatencyMs ?? 0, normalized: latencySignal, weight: 0.1 }]),
    ];

    const totalWeight = signals.reduce((sum, signal) => sum + signal.weight, 0);
    const score = signals.reduce((sum, signal) => sum + signal.normalized * signal.weight, 0) / totalWeight;
    const riskLevel = this.riskLevel(score);
    const confidence = Math.min(1, current.total / 50) * Math.min(1, baseline.total / 100);
    const lostApprovals = Math.max(0, Math.round(approvalDrop * current.total));
    const estimatedLossCents = lostApprovals * current.averageAmountCents;
    const dimensions = this.dimensions(dimension, key, sample);

    return {
      key,
      label: dimension === 'route' ? `${sample.provider}/${sample.method}/${sample.country}/${sample.issuingBank}` : key,
      groupBy: dimension,
      dimensions,
      score: Number(score.toFixed(4)),
      riskLevel,
      confidence: Number(confidence.toFixed(3)),
      current,
      baseline,
      approvalDrop: Number(approvalDrop.toFixed(4)),
      estimatedLossCents,
      signals: signals.map((signal) => ({
        ...signal,
        contribution: Number(((signal.normalized * signal.weight) / totalWeight).toFixed(4)),
      })),
      recommendation: this.recommendation(dimension, riskLevel, sample),
    };
  }

  private dimensions(dimension: AnalysisDimension, key: string, sample: Tx) {
    if (dimension === 'route') {
      return {
        merchant: sample.merchant,
        provider: sample.provider,
        method: sample.method,
        country: sample.country,
        issuingBank: sample.issuingBank,
      };
    }
    return { [dimension]: key };
  }

  private recommendation(dimension: AnalysisDimension, risk: RiskLevel, tx: Tx) {
    if (risk === 'LOW') return 'Continuar monitoreo; no se requiere acción inmediata.';
    if (risk === 'MEDIUM') return 'Revisar tendencia y códigos de rechazo antes de modificar el routing.';

    const prefix = risk === 'CRITICAL' ? 'Acción inmediata: ' : '';
    switch (dimension) {
      case 'provider':
        return `${prefix}reducir tráfico hacia ${tx.provider} y evaluar failover a un proveedor alterno.`;
      case 'issuingBank':
        return `${prefix}aislar rechazos de ${tx.issuingBank} y probar ruta/proveedor alternativo.`;
      case 'method':
        return `${prefix}revisar degradación de ${tx.method} y priorizar métodos alternativos disponibles.`;
      case 'country':
        return `${prefix}validar degradación regional en ${tx.country} y ajustar routing por país.`;
      case 'merchant':
        return `${prefix}revisar configuración y patrón de rechazos específico de ${tx.merchant}.`;
      default:
        return `${prefix}desviar tráfico de la ruta ${tx.provider}/${tx.method}/${tx.country}/${tx.issuingBank} y comparar recuperación.`;
    }
  }

  private riskLevel(score: number): RiskLevel {
    if (score >= 0.75) return 'CRITICAL';
    if (score >= 0.5) return 'HIGH';
    if (score >= 0.25) return 'MEDIUM';
    return 'LOW';
  }

  private clamp(value: number) {
    return Math.max(0, Math.min(1, value));
  }
}
