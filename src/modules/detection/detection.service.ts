import { Injectable, Logger } from '@nestjs/common';
import {
  DIMENSIONS,
  buildSegmentKey,
  combinations,
  isRefinementOf,
  type Dimension,
  type DimensionMap,
} from '../../common/dimensions.js';
import { approvalRate, confidenceFrom, round, zScore } from '../../common/stats.js';
import { BaselinesService, type BaselineLookup } from '../baselines/baselines.service.js';
import { IncidentsRepository } from '../incidents/incidents.repository.js';
import { TransactionsRepository, type SliceCount } from '../transactions/transactions.repository.js';
import { DetectionRepository } from './detection.repository.js';
import { buildExplanation } from './explanation.js';
import type { RunDetectionDto } from './dto/run-detection.dto.js';
import type { DetectionOutcome, Prisma } from '../../generated/prisma/client.js';

type Candidate = {
  dimensions: DimensionMap;
  segmentKey: string;
  depth: number;
  attempts: number;
  approved: number;
  observedRate: number;
  amountUsdCents: number;
  baseline: BaselineLookup;
  drop: number;
  z: number;
  confidence: number;
  lostApprovals: number;
  averageTicketCents: number;
  lossPerMinuteCents: number;
  severity: number;
};

@Injectable()
export class DetectionService {
  private readonly logger = new Logger(DetectionService.name);

  constructor(
    private readonly transactions: TransactionsRepository,
    private readonly baselines: BaselinesService,
    private readonly incidents: IncidentsRepository,
    private readonly runs: DetectionRepository,
  ) {}

  /**
   * Una pasada completa de deteccion y diagnostico.
   *
   * El recorrido del espacio de dimensiones es totalmente generico: se
   * enumeran combinaciones desde el array DIMENSIONS, se agregan en SQL y
   * se comparan contra el baseline del segmento. Ninguna rama del codigo
   * conoce un proveedor, un banco o un pais concreto.
   */
  async run(dto: RunDetectionDto) {
    const startedAt = Date.now();
    const windowMinutes = dto.windowMinutes ?? 15;
    const maxDepth = Math.min(dto.maxDepth ?? 3, DIMENSIONS.length);
    const minSampleSize = dto.minSampleSize ?? 20;
    const minZScore = dto.minZScore ?? 2.5;
    const minConfidence = dto.minConfidence ?? 0.35;
    const minDrop = dto.minDrop ?? 0.1;

    const now = new Date();
    const windowStart = new Date(now.getTime() - windowMinutes * 60_000);
    const baselineEnd = windowStart;
    const baselineStart = new Date(baselineEnd.getTime() - 24 * 14 * 3_600_000);

    const run = await this.runs.createRun({
      windowStart,
      windowEnd: now,
      baselineStart,
      baselineEnd,
      params: { windowMinutes, maxDepth, minSampleSize, minZScore, minConfidence, minDrop } as never,
      outcome: 'NO_ANOMALY',
    });

    // 1. Enumerar y agregar todas las combinaciones de la ventana actual.
    const slicesByDepth = new Map<number, SliceCount[]>();
    let combosEvaluated = 0;

    for (let depth = 1; depth <= maxDepth; depth++) {
      const collected: SliceCount[] = [];
      for (const combo of combinations(DIMENSIONS, depth)) {
        const slices = await this.transactions.aggregateBy(combo as Dimension[], windowStart, now);
        collected.push(...slices.filter((slice) => slice.attempts >= minSampleSize));
        combosEvaluated += 1;
      }
      slicesByDepth.set(depth, collected);
    }

    // 2. Contrastar cada slice contra su baseline.
    const allSlices = [...slicesByDepth.values()].flat();
    const segmentKeys = allSlices.map((slice) => buildSegmentKey(slice.dimensions));
    const baselineIndex = await this.baselines.lookupMany(segmentKeys, now);

    const candidates: Candidate[] = [];
    for (const slice of allSlices) {
      const segmentKey = buildSegmentKey(slice.dimensions);
      const baseline = baselineIndex.get(segmentKey);
      if (!baseline || baseline.source === 'none' || baseline.sampleSize < minSampleSize) continue;

      const observedRate = approvalRate(slice.approved, slice.attempts);
      const drop = baseline.expectedRate - observedRate;
      if (drop < minDrop) continue;

      const z = zScore(observedRate, baseline.expectedRate, slice.attempts, baseline.variance);
      if (z < minZScore) continue;

      const confidence = confidenceFrom(z, slice.attempts, minSampleSize);
      if (confidence < minConfidence) continue;

      const lostApprovals = Math.max(0, Math.round(drop * slice.attempts));
      const averageTicketCents = slice.attempts > 0 ? Math.round(slice.amountUsdCents / slice.attempts) : 0;
      const lossPerMinuteCents = Math.round((lostApprovals * averageTicketCents) / windowMinutes);

      candidates.push({
        dimensions: slice.dimensions,
        segmentKey,
        depth: Object.keys(slice.dimensions).length,
        attempts: slice.attempts,
        approved: slice.approved,
        observedRate: round(observedRate),
        amountUsdCents: slice.amountUsdCents,
        baseline,
        drop: round(drop),
        z: round(z),
        confidence,
        lostApprovals,
        averageTicketCents,
        lossPerMinuteCents,
        severity: severityOf(confidence, drop),
      });
    }

    // 3. Quedarse con la explicacion mas especifica de cada familia.
    const winners = prune(candidates);

    // 4. Persistir: upsert por anclaje, nueva version de diagnostico.
    const results = [];
    for (const winner of winners) {
      const anchor = anchorFor(winner, candidates);
      results.push(await this.persist(run.id, winner, anchor, candidates, windowStart, now));
    }

    // 5. Cerrar lo que ya no se ve.
    const resolved = await this.incidents.autoResolveStale(
      new Date(now.getTime() - (dto.resolveAfterMinutes ?? 30) * 60_000),
    );

    const outcome: DetectionOutcome =
      winners.length > 0
        ? 'INCIDENTS_FOUND'
        : allSlices.length === 0
          ? 'INSUFFICIENT_EVIDENCE'
          : 'NO_ANOMALY';

    await this.runs.finishRun(run.id, outcome, combosEvaluated, Date.now() - startedAt);

    this.logger.log(
      `Deteccion ${outcome}: ${combosEvaluated} combinaciones, ${allSlices.length} slices con muestra, ${winners.length} incidentes`,
    );

    return {
      runId: run.id,
      outcome,
      window: { from: windowStart, to: now, minutes: windowMinutes },
      combosEvaluated,
      slicesWithSample: allSlices.length,
      candidates: candidates.length,
      incidents: results,
      autoResolved: resolved.count,
    };
  }

  private async persist(
    runId: string,
    winner: Candidate,
    anchorFingerprint: string,
    allCandidates: Candidate[],
    windowStart: Date,
    now: Date,
  ) {
    const fingerprint = winner.segmentKey;
    const existing = await this.incidents.findOpenByAnchor(anchorFingerprint);
    const samples = await this.transactions.sampleIds(winner.dimensions, windowStart, now);

    const startedAt = existing?.startedAt ?? windowStart;
    const explanation = buildExplanation({
      dimensions: winner.dimensions,
      expectedRate: winner.baseline.expectedRate,
      observedRate: winner.observedRate,
      observedAttempts: winner.attempts,
      baselineAttempts: winner.baseline.sampleSize,
      confidence: winner.confidence,
      lossPerMinuteCents: winner.lossPerMinuteCents,
      lostApprovals: winner.lostApprovals,
      startedAt,
      baselineSource: winner.baseline.source,
    });

    const metrics = {
      fingerprint,
      severity: winner.severity,
      expectedApprovals: Math.round(winner.baseline.expectedRate * winner.attempts),
      actualApprovals: winner.approved,
      lostApprovals: winner.lostApprovals,
      averageTicketCents: winner.averageTicketCents,
      lossPerMinuteCents: winner.lossPerMinuteCents,
      lastSeenAt: now,
      ...explanation,
    };

    const incidentId = existing
      ? (await this.incidents.update(existing.id, metrics)).id
      : (
          await this.incidents.create({
            detectionRun: { connect: { id: runId } },
            anchorFingerprint,
            startedAt,
            detectedAt: now,
            ...metrics,
          })
        ).id;

    const version = (await this.incidents.nextVersion(incidentId)) + 1;
    const evidence = buildEvidenceRows(winner, allCandidates);

    const diagnosis = await this.incidents.addDiagnosis({
      incident: { connect: { id: incidentId } },
      detectionRun: { connect: { id: runId } },
      version,
      fingerprint,
      dimensions: winner.dimensions as never,
      dimensionDepth: winner.depth,
      baselineRate: winner.baseline.expectedRate,
      observedRate: winner.observedRate,
      baselineAttempts: winner.baseline.sampleSize,
      observedAttempts: winner.attempts,
      confidence: winner.confidence,
      sampleTransactionIds: samples.map((row) => row.id) as never,
      evidence: { create: evidence },
    } as Prisma.IncidentDiagnosisCreateInput);

    return {
      incidentId,
      diagnosisId: diagnosis.id,
      version,
      isNew: !existing,
      refined: Boolean(existing && existing.fingerprint !== fingerprint),
      fingerprint,
      anchorFingerprint,
    };
  }
}

/**
 * Dos explicaciones CONFLICTAN si fijan la misma dimension con valores
 * distintos: no pueden describir las mismas transacciones.
 *
 * "country=BR|provider=Adyen" y "country=MX|provider=Stripe" conflictan,
 * asi que son incidentes separados. "country=BR|provider=Adyen" y
 * "merchant=Mercado Uno|method=CARD" no conflictan: pueden estar hablando
 * de las mismas transacciones, y solo debe sobrevivir la mejor.
 */
export function conflicts(a: DimensionMap, b: DimensionMap): boolean {
  return Object.entries(a).some(([key, value]) => {
    const other = b[key as Dimension];
    return other !== undefined && other !== value;
  });
}

/**
 * Seleccion por cobertura.
 *
 * Sin esto, una sola caida produce una veintena de "incidentes" que son la
 * misma historia contada por dimensiones distintas: la UI se llena de ruido
 * y la separacion de incidentes simultaneos deja de significar nada.
 *
 * Regla: recorrer los candidatos del mas especifico y confiable al menos, y
 * quedarse con uno solo por cada familia mutuamente compatible. Solo las
 * explicaciones que se excluyen entre si se convierten en incidentes aparte.
 */
export function prune(candidates: Candidate[]): Candidate[] {
  const sorted = [...candidates].sort(
    (a, b) => b.depth - a.depth || b.confidence - a.confidence || b.drop - a.drop,
  );
  const kept: Candidate[] = [];

  for (const candidate of sorted) {
    const alreadyCovered = kept.some((winner) => !conflicts(winner.dimensions, candidate.dimensions));
    if (!alreadyCovered) kept.push(candidate);
  }

  return kept.sort((a, b) => b.severity - a.severity || b.lossPerMinuteCents - a.lossPerMinuteCents);
}

/**
 * Anclaje estable: la dimension individual con la señal mas fuerte dentro
 * del diagnostico. No cambia cuando el diagnostico se afina, asi que sirve
 * para reconocer el mismo incidente entre corridas.
 */
export function anchorFor(winner: Candidate, all: Candidate[]): string {
  const singles = all.filter(
    (candidate) => candidate.depth === 1 && isRefinementOf(winner.dimensions, candidate.dimensions),
  );
  if (singles.length === 0) {
    const [first] = Object.entries(winner.dimensions).sort(([a], [b]) => a.localeCompare(b));
    return first ? buildSegmentKey({ [first[0] as Dimension]: first[1] }) : winner.segmentKey;
  }
  const strongest = singles.reduce((best, candidate) => (candidate.drop > best.drop ? candidate : best));
  return strongest.segmentKey;
}

function buildEvidenceRows(winner: Candidate, all: Candidate[]) {
  const rootKeys = new Set(Object.keys(winner.dimensions));
  const singles = all.filter((candidate) => candidate.depth === 1);
  const rows = singles
    .filter((candidate) => isRefinementOf(winner.dimensions, candidate.dimensions))
    .map((candidate) => {
      const [dimension, value] = Object.entries(candidate.dimensions)[0] ?? ['unknown', ''];
      return {
        dimension,
        dimensionValue: String(value),
        baselineRate: candidate.baseline.expectedRate,
        observedRate: candidate.observedRate,
        difference: candidate.drop,
        attempts: candidate.attempts,
        confidence: candidate.confidence,
        isRootCause: rootKeys.has(dimension),
      };
    });

  if (rows.length > 0) return rows;

  return Object.entries(winner.dimensions).map(([dimension, value]) => ({
    dimension,
    dimensionValue: String(value),
    baselineRate: winner.baseline.expectedRate,
    observedRate: winner.observedRate,
    difference: winner.drop,
    attempts: winner.attempts,
    confidence: winner.confidence,
    isRootCause: true,
  }));
}

function severityOf(confidence: number, drop: number): number {
  const score = confidence * 0.6 + Math.min(1, drop / 0.5) * 0.4;
  if (score >= 0.8) return 4;
  if (score >= 0.6) return 3;
  if (score >= 0.4) return 2;
  return 1;
}
