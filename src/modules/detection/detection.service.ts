import { Injectable, Logger } from '@nestjs/common';
import { EscalationService } from '../alerts/escalation.service.js';
import {
  DIMENSIONS,
  buildSegmentKey,
  combinations,
  isRefinementOf,
  type Dimension,
  type DimensionMap,
} from '../../common/dimensions.js';
import { approvalRate, confidenceFrom, round, zScore } from '../../common/stats.js';
import {
  calculateEconomicImpact,
  calculateIncidentPriority,
  evaluateAnomaly,
  hasSustainedRecovery,
  isAnomalyConfirmed,
  isSevereAnomaly,
  rootCauseConfidence,
  topDeclineReasons,
  type DeclineReasonRow,
} from '../../common/detection-metrics.js';
import { AlertsService } from '../alerts/alerts.service.js';
import { BaselinesService, type BaselineLookup } from '../baselines/baselines.service.js';
import { IncidentsRepository } from '../incidents/incidents.repository.js';
import { TransactionsRepository, type SliceCount } from '../transactions/transactions.repository.js';
import { DetectionRepository } from './detection.repository.js';
import { buildExplanation } from './explanation.js';
import type { RunDetectionDto } from './dto/run-detection.dto.js';
import type { DetectionOutcome, Prisma } from '../../generated/prisma/client.js';

export type Candidate = {
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
  anomalyConfidence: number;
  rootCauseConfidence: number;
  priorityScore: number;
};

@Injectable()
export class DetectionService {
  private readonly logger = new Logger(DetectionService.name);

  constructor(
    private readonly transactions: TransactionsRepository,
    private readonly baselines: BaselinesService,
    private readonly incidents: IncidentsRepository,
    private readonly runs: DetectionRepository,
    private readonly escalation: EscalationService,
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
    const confirmationRuns = dto.confirmationRuns ?? 2;
    const recoveryRuns = dto.recoveryRuns ?? 2;

    const now = new Date();
    const windowStart = new Date(now.getTime() - windowMinutes * 60_000);
    const baselineEnd = windowStart;
    const baselineStart = new Date(baselineEnd.getTime() - 24 * 14 * 3_600_000);

    const run = await this.runs.createRun({
      windowStart,
      windowEnd: now,
      baselineStart,
      baselineEnd,
      params: {
        windowMinutes,
        maxDepth,
        minSampleSize,
        minZScore,
        minConfidence,
        minDrop,
        confirmationRuns,
        recoveryRuns,
      } as never,
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
    const baselineIndex = await this.baselines.lookupMany(
      allSlices.map((slice) => slice.dimensions),
      now,
      minSampleSize,
    );

    const candidates: Candidate[] = [];
    const evaluatedCandidates: Candidate[] = [];
    let slicesWithUsableBaseline = 0;
    let slicesWithoutBaseline = 0;
    let slicesStatisticallyEvaluated = 0;
    let suppressedNoiseCandidates = 0;
    for (const slice of allSlices) {
      const segmentKey = buildSegmentKey(slice.dimensions);
      const baseline = baselineIndex.get(segmentKey);
      if (!baseline || baseline.source === 'none' || baseline.sampleSize < minSampleSize) {
        slicesWithoutBaseline += 1;
        continue;
      }
      slicesWithUsableBaseline += 1;

      const observedRate = approvalRate(slice.approved, slice.attempts);
      const drop = baseline.expectedRate - observedRate;
      slicesStatisticallyEvaluated += 1;
      const z = zScore(observedRate, baseline.expectedRate, slice.attempts, baseline.variance);
      const confidence = round(
        confidenceFrom(z, slice.attempts, minSampleSize) * baselineConfidenceFactor(baseline.source),
      );
      const evaluation = evaluateAnomaly({
        attempts: slice.attempts,
        drop,
        zScore: z,
        confidence,
        minSampleSize,
        minDrop,
        minZScore,
        minConfidence,
      });
      const impact = calculateEconomicImpact({
        attempts: slice.attempts,
        approved: slice.approved,
        baselineRate: baseline.expectedRate,
        amountUsdCents: slice.amountUsdCents,
        windowMinutes,
      });
      const severity = severityOf(confidence, drop);
      const causeConfidence = rootCauseConfidence(confidence, baseline.source, false);

      const evaluatedCandidate: Candidate = {
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
        lostApprovals: impact.lostApprovals,
        averageTicketCents: impact.averageTicketCents,
        lossPerMinuteCents: impact.lossPerMinuteCents,
        severity,
        anomalyConfidence: confidence,
        rootCauseConfidence: causeConfidence,
        priorityScore: calculateIncidentPriority({
          lossPerMinuteCents: impact.lossPerMinuteCents,
          severity,
          confidence,
          lostApprovals: impact.lostApprovals,
          evidenceSufficient: true,
        }),
      };
      evaluatedCandidates.push(evaluatedCandidate);
      if (!evaluation.finalCandidate) {
        suppressedNoiseCandidates += 1;
        continue;
      }
      candidates.push(evaluatedCandidate);
    }

    for (const candidate of candidates) {
      const hasHealthySibling = evaluatedCandidates.some(
        (other) =>
          other !== candidate &&
          other.observedRate >= other.baseline.expectedRate - 0.03 &&
          isRelevantSibling(candidate.dimensions, other.dimensions),
      );
      candidate.rootCauseConfidence = rootCauseConfidence(
        candidate.anomalyConfidence,
        candidate.baseline.source,
        hasHealthySibling,
      );
    }

    // 3. Quedarse con la explicacion mas especifica de cada familia.
    const winners = prune(candidates);
    const winnerAnchors = winners.map((winner) => ({
      winner,
      anchor: anchorFor(winner, candidates, winners),
    }));
    const recentRunCutoff = new Date(
      now.getTime() - Math.max(5, windowMinutes * 2) * 60_000,
    );
    const previousRuns =
      confirmationRuns <= 1
        ? []
        : await this.runs.findRecentRuns(run.id, confirmationRuns - 1, recentRunCutoff);
    const confirmed = winnerAnchors.filter(({ winner, anchor }) => {
      const severe = isSevereAnomaly({
        drop: winner.drop,
        zScore: winner.z,
        confidence: winner.confidence,
        lossPerMinuteCents: winner.lossPerMinuteCents,
      });
      return isAnomalyConfirmed({
        anchor,
        confirmationRuns,
        severe,
        previousCandidateAnchors: previousRuns.map((previous) =>
          runCandidateAnchors(previous.params),
        ),
      });
    });

    // 4. Persistir: upsert por anclaje, nueva version de diagnostico.
    const results = [];
    for (const { winner, anchor } of confirmed) {
      results.push(
        await this.persist(
          run.id,
          winner,
          anchor,
          evaluatedCandidates,
          baselineStart,
          windowStart,
          now,
        ),
      );
    }
    const prioritizedResults = results
      .sort((left, right) => right.priorityScore - left.priorityScore)
      .map((incident, index) => ({ ...incident, priorityRank: index + 1 }));

    const outcome = detectionOutcome(confirmed.length, allSlices.length, slicesStatisticallyEvaluated);
    const evidenceReason =
      outcome !== 'INSUFFICIENT_EVIDENCE'
        ? undefined
        : allSlices.length === 0
          ? 'NO_SLICES_WITH_MIN_SAMPLE'
          : 'NO_USABLE_HISTORICAL_BASELINE';

    const runParams = {
      windowMinutes,
      maxDepth,
      minSampleSize,
      minZScore,
      minConfidence,
      minDrop,
      confirmationRuns,
      recoveryRuns,
      candidateAnchors: winnerAnchors.map(({ anchor }) => anchor),
    };
    await this.runs.finishRun(
      run.id,
      outcome,
      combosEvaluated,
      Date.now() - startedAt,
      runParams as never,
    );

    // 5. Resolver solo tras recuperacion sostenida o tras el timeout conservador existente.
    const recentRecoveryRuns = await this.runs.findRecentRuns('', recoveryRuns, recentRunCutoff);
    const activeIncidents = await this.incidents.findActive();
    const recoveredIds =
      recentRecoveryRuns.length < recoveryRuns
        ? []
        : activeIncidents
            .filter((incident) =>
              hasSustainedRecovery({
                anchor: incident.anchorFingerprint,
                recoveryRuns,
                recentCandidateAnchors: recentRecoveryRuns.map((recent) =>
                  runCandidateAnchors(recent.params),
                ),
              }),
            )
            .map((incident) => incident.id);
    const recovered = await this.incidents.resolveMany(recoveredIds, now);
    const stale = await this.incidents.autoResolveStale(
      new Date(now.getTime() - (dto.resolveAfterMinutes ?? 30) * 60_000),
    );
    const autoResolved = recovered.count + stale.count;

    this.logger.log(
      `Deteccion ${outcome}: ${combosEvaluated} combinaciones, ${allSlices.length} slices con muestra, ${confirmed.length} incidentes`,
    );

    return {
      runId: run.id,
      outcome,
      window: { from: windowStart, to: now, minutes: windowMinutes },
      combosEvaluated,
      slicesWithSample: allSlices.length,
      slicesWithUsableBaseline,
      slicesWithoutBaseline,
      slicesStatisticallyEvaluated,
      candidates: candidates.length,
      evaluatedSlices: allSlices.length,
      confirmedCandidates: confirmed.length,
      suppressedNoiseCandidates,
      incidents: prioritizedResults,
      autoResolved,
      ...(evidenceReason ? { evidenceReason } : {}),
    };
  }

  private async persist(
    runId: string,
    winner: Candidate,
    anchorFingerprint: string,
    allCandidates: Candidate[],
    baselineStart: Date,
    windowStart: Date,
    now: Date,
  ) {
    const fingerprint = winner.segmentKey;
    const existing = await this.incidents.findOpenByAnchor(anchorFingerprint);
    const [samples, currentDeclines, baselineDeclines] = await Promise.all([
      this.transactions.sampleIds(winner.dimensions, windowStart, now),
      this.transactions.aggregateDeclineReasons(winner.dimensions, windowStart, now),
      this.transactions.aggregateDeclineReasons(winner.dimensions, baselineStart, windowStart),
    ]);
    const declineReasons = topDeclineReasons(currentDeclines, baselineDeclines);

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
      expectedApprovals: calculateEconomicImpact({
        attempts: winner.attempts,
        approved: winner.approved,
        baselineRate: winner.baseline.expectedRate,
        amountUsdCents: winner.amountUsdCents,
        windowMinutes: 1,
      }).expectedApprovals,
      actualApprovals: winner.approved,
      lostApprovals: winner.lostApprovals,
      averageTicketCents: winner.averageTicketCents,
      lossPerMinuteCents: winner.lossPerMinuteCents,
      lastSeenAt: now,
      ...explanation,
    };

    const persistence = incidentPersistenceDecision(existing, fingerprint);
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

    const version = nextDiagnosisVersion(await this.incidents.nextVersion(incidentId));
    const evidence = buildEvidenceRows(winner, allCandidates, declineReasons);

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

    if (!existing) {
      // Abre la cadena de escalamiento. Solo para incidentes nuevos: un
      // diagnostico refinado sobre el mismo incidente no reinicia los relojes.
      await this.escalation.openForIncident({
        id: incidentId,
        anchorFingerprint,
        startedAt,
        detectedAt: now,
        ...metrics,
      });
    }

    return {
      incidentId,
      diagnosisId: diagnosis.id,
      version,
      isNew: persistence.isNew,
      refined: persistence.refined,
      fingerprint,
      anchorFingerprint,
      priorityScore: winner.priorityScore,
      baselineSource: winner.baseline.source,
      baselineSampleSize: winner.baseline.sampleSize,
      baselineExpectedRate: winner.baseline.expectedRate,
      baselineVariance: winner.baseline.variance,
      baselineMatchedDimensions: winner.baseline.matchedDimensions,
      baselineFallbackDepth: winner.baseline.fallbackDepth,
      anomalyConfidence: winner.anomalyConfidence,
      rootCauseConfidence: winner.rootCauseConfidence,
      topDeclineReasons: declineReasons,
    };
  }
}

/**
 * Dos explicaciones CONFLICTAN si fijan la misma dimension con valores
 * distintos: no pueden describir las mismas transacciones.
 *
 * "country=BR|provider=Adyen" y "country=MX|provider=Stripe" conflictan,
 * asi que son incidentes separados. "country=BR|provider=Adyen" y
 * "merchant=Mercado Uno|method=CARD" no conflictan, pero eso por si solo ya
 * no demuestra que pertenezcan a la misma familia.
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
 * Regla: recorrer los candidatos del mas especifico y confiable al menos. Dos
 * candidatos pertenecen a la misma familia solo si hay refinamiento directo o
 * un candidato mas especifico que conecta a ambos. La mera compatibilidad no
 * basta para fusionar degradaciones independientes.
 */
export function prune(candidates: Candidate[]): Candidate[] {
  const sorted = [...candidates].sort(
    (a, b) => b.depth - a.depth || b.confidence - a.confidence || b.drop - a.drop,
  );
  const kept: Candidate[] = [];

  for (const candidate of sorted) {
    const alreadyCovered = kept.some((winner) => sameCandidateFamily(winner, candidate, candidates));
    if (!alreadyCovered) kept.push(candidate);
  }

  return kept.sort((a, b) => b.severity - a.severity || b.lossPerMinuteCents - a.lossPerMinuteCents);
}

/**
 * Anclaje estable: la dimension individual con la señal mas fuerte dentro
 * del diagnostico. No cambia cuando el diagnostico se afina, asi que sirve
 * para reconocer el mismo incidente entre corridas.
 */
export function anchorFor(winner: Candidate, all: Candidate[], winners: Candidate[] = [winner]): string {
  const others = winners.filter((candidate) => candidate !== winner);
  if (others.length > 0) {
    const keys = Object.keys(winner.dimensions) as Dimension[];
    for (let size = 1; size <= keys.length; size++) {
      const subsets = combinations(keys, size)
        .map((subset) => {
          const dimensions = Object.fromEntries(
            subset.map((dimension) => [dimension, winner.dimensions[dimension]]),
          ) as DimensionMap;
          return { dimensions, segmentKey: buildSegmentKey(dimensions) };
        })
        .sort((a, b) => a.segmentKey.localeCompare(b.segmentKey));
      const distinguishing = subsets.find((subset) =>
        others.every((other) => conflicts(subset.dimensions, other.dimensions)),
      );
      if (distinguishing) return distinguishing.segmentKey;
    }
    return winner.segmentKey;
  }

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

export function sameCandidateFamily(a: Candidate, b: Candidate, all: Candidate[]): boolean {
  if (isRefinementOf(a.dimensions, b.dimensions) || isRefinementOf(b.dimensions, a.dimensions)) {
    return true;
  }
  return all.some(
    (bridge) =>
      bridge !== a &&
      bridge !== b &&
      isRefinementOf(bridge.dimensions, a.dimensions) &&
      isRefinementOf(bridge.dimensions, b.dimensions),
  );
}

export function detectionOutcome(
  winnerCount: number,
  slicesWithSample: number,
  slicesStatisticallyEvaluated: number,
): DetectionOutcome {
  if (winnerCount > 0) return 'INCIDENTS_FOUND';
  if (slicesStatisticallyEvaluated > 0) return 'NO_ANOMALY';
  return 'INSUFFICIENT_EVIDENCE';
}

export function baselineConfidenceFactor(source: BaselineLookup['source']): number {
  if (source.startsWith('platform_')) return 0.65;
  if (source.startsWith('ancestor_')) return 0.85;
  if (source === 'none') return 0;
  return 1;
}

export function runCandidateAnchors(params: unknown): string[] {
  if (!params || typeof params !== 'object' || !('candidateAnchors' in params)) return [];
  const anchors = (params as { candidateAnchors?: unknown }).candidateAnchors;
  return Array.isArray(anchors) ? anchors.filter((value): value is string => typeof value === 'string') : [];
}

export function incidentPersistenceDecision(
  existing: { id: string; fingerprint: string } | null,
  fingerprint: string,
) {
  return {
    incidentId: existing?.id ?? null,
    isNew: existing === null,
    refined: existing !== null && existing.fingerprint !== fingerprint,
  };
}

export function nextDiagnosisVersion(existingCount: number) {
  return existingCount + 1;
}

export function buildEvidenceRows(
  winner: Candidate,
  all: Candidate[],
  declineReasons: DeclineReasonRow[] = [],
) {
  const rootKeys = new Set(Object.keys(winner.dimensions));
  const direct = {
    dimension: 'affectedScope',
    dimensionValue: winner.segmentKey,
    baselineRate: winner.baseline.expectedRate,
    observedRate: winner.observedRate,
    difference: winner.drop,
    attempts: winner.attempts,
    confidence: winner.confidence,
    isRootCause: true,
  };
  const singles = all.filter((candidate) => candidate.depth === 1);
  const affected = singles
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
  const controls = all
    .filter(
      (candidate) =>
        candidate.segmentKey !== winner.segmentKey &&
        candidate.observedRate >= candidate.baseline.expectedRate - 0.03 &&
        isRelevantSibling(winner.dimensions, candidate.dimensions),
    )
    .sort((left, right) => right.attempts - left.attempts)
    .slice(0, 2)
    .map((candidate) => ({
      dimension: 'controlSibling',
      dimensionValue: candidate.segmentKey,
      baselineRate: candidate.baseline.expectedRate,
      observedRate: candidate.observedRate,
      difference: candidate.drop,
      attempts: candidate.attempts,
      confidence: candidate.confidence,
      isRootCause: false,
    }));
  const declines = declineReasons.slice(0, 3).map((reason) => ({
    dimension: 'failureReason',
    dimensionValue: reason.code,
    baselineRate: reason.baselineShare ?? 0,
    observedRate: reason.shareOfDeclines,
    difference: reason.shareDelta ?? 0,
    attempts: reason.count,
    confidence: winner.confidence,
    isRootCause: false,
  }));
  return [direct, ...affected, ...controls, ...declines].slice(0, 8);
}

function isRelevantSibling(winner: DimensionMap, candidate: DimensionMap) {
  const winnerEntries = Object.entries(winner);
  const candidateEntries = Object.entries(candidate);
  if (winnerEntries.length !== candidateEntries.length) return false;
  let differences = 0;
  for (const [key, value] of winnerEntries) {
    if (candidate[key as Dimension] !== value) differences += 1;
  }
  return differences === 1;
}

function severityOf(confidence: number, drop: number): number {
  const score = confidence * 0.6 + Math.min(1, drop / 0.5) * 0.4;
  if (score >= 0.8) return 4;
  if (score >= 0.6) return 3;
  if (score >= 0.4) return 2;
  return 1;
}
