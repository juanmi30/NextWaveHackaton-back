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
  isolatedUnseenDimension: Dimension | null;
  healthySiblingValues: string[];
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
        isolatedUnseenDimension: null,
        healthySiblingValues: [],
      };
      evaluatedCandidates.push(evaluatedCandidate);
      if (!evaluation.finalCandidate) {
        suppressedNoiseCandidates += 1;
        continue;
      }
      candidates.push(evaluatedCandidate);
    }

    for (const candidate of candidates) {
      const isolation = evaluateUnseenChildIsolation(
        candidate,
        evaluatedCandidates,
        minSampleSize,
      );
      candidate.isolatedUnseenDimension = isolation.dimension;
      candidate.healthySiblingValues = isolation.healthySiblingValues;
      const hasHealthySibling =
        isolation.isolated ||
        evaluatedCandidates.some(
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
    const families = groupAnomalyFamilies(candidates);
    const winners = families.map(selectCanonicalWinner);
    const activeIncidentLineages = await this.incidents.findActiveWithLatestDiagnosis();
    const winnerAnchors = winners.map((winner, index) => {
      const family = families[index]!;
      const proposedAnchor = stableFamilyAnchor(family, winner);
      const existing = resolveExistingIncident({
        proposedAnchor,
        winner,
        family,
        activeIncidents: activeIncidentLineages,
      });
      return {
        winner,
        family,
        anchor: existing?.anchorFingerprint ?? proposedAnchor,
      };
    });
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
    for (const { winner, family, anchor } of confirmed) {
      results.push(
        await this.persist(
          run.id,
          winner,
          anchor,
          family,
          activeIncidentLineages,
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
    const durationMs = Date.now() - startedAt;
    await this.runs.finishRun(
      run.id,
      outcome,
      combosEvaluated,
      durationMs,
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
      durationMs,
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
    family: Candidate[],
    activeIncidentLineages: ActiveIncidentLineage[],
    allCandidates: Candidate[],
    baselineStart: Date,
    windowStart: Date,
    now: Date,
  ) {
    const fingerprint = winner.segmentKey;
    const existing = resolveExistingIncident({
      proposedAnchor: anchorFingerprint,
      winner,
      family,
      activeIncidents: activeIncidentLineages,
    });
    const [samples, currentDeclines, baselineDeclines] = await Promise.all([
      this.transactions.sampleIds(winner.dimensions, windowStart, now),
      this.transactions.aggregateDeclineReasons(winner.dimensions, windowStart, now),
      this.transactions.aggregateDeclineReasons(winner.dimensions, baselineStart, windowStart),
    ]);
    const declineReasons = topDeclineReasons(currentDeclines, baselineDeclines);

    const startedAt = existing?.startedAt ?? windowStart;
    const diagnosisConfidence = winner.isolatedUnseenDimension
      ? winner.rootCauseConfidence
      : winner.confidence;
    const explanation = buildExplanation({
      dimensions: winner.dimensions,
      expectedRate: winner.baseline.expectedRate,
      observedRate: winner.observedRate,
      observedAttempts: winner.attempts,
      baselineAttempts: winner.baseline.sampleSize,
      confidence: diagnosisConfidence,
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
      confidence: diagnosisConfidence,
      sampleTransactionIds: samples.map((row) => row.id) as never,
      evidence: { create: evidence },
    } as Prisma.IncidentDiagnosisCreateInput);

    if (!existing) {
      // Abre la cadena de escalamiento. Solo para incidentes nuevos: un
      // diagnostico refinado sobre el mismo incidente no reinicia los relojes.
      const routingFingerprint = alertRoutingFingerprint(fingerprint, declineReasons);
      await bestEffort(
        () => this.escalation.openForIncident({
          id: incidentId,
          anchorFingerprint,
          startedAt,
          detectedAt: now,
          ...metrics,
          fingerprint: routingFingerprint,
        }),
        (error) => this.logger.warn(
          `Incident ${incidentId} persisted but escalation could not be opened: ${safeError(error)}`,
        ),
      );
    }

    return {
      incidentId,
      diagnosisId: diagnosis.id,
      version,
      isNew: persistence.isNew,
      refined: persistence.refined,
      fingerprint,
      // El anchor pertenece a la historia y es inmutable; el fingerprint
      // representa solamente la version vigente del diagnostico.
      anchorFingerprint: existing?.anchorFingerprint ?? anchorFingerprint,
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
  return groupAnomalyFamilies(candidates)
    .map(selectCanonicalWinner)
    .sort((a, b) => b.priorityScore - a.priorityScore);
}

export function groupAnomalyFamilies(candidates: Candidate[]): Candidate[][] {
  const multiDimension = candidates.filter((candidate) => candidate.depth >= 2);
  if (multiDimension.length === 0) return candidates.map((candidate) => [candidate]);

  const pending = new Set(multiDimension);
  const families: Candidate[][] = [];
  while (pending.size > 0) {
    const first = pending.values().next().value as Candidate;
    pending.delete(first);
    const family = [first];
    const queue = [first];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const candidate of pending) {
        if (sharedDimensionCount(current.dimensions, candidate.dimensions) < 2) continue;
        pending.delete(candidate);
        family.push(candidate);
        queue.push(candidate);
      }
    }
    families.push(family);
  }

  // Una proyeccion de una dimension sirve como evidencia, pero nunca como
  // bridge para fusionar historias que solo comparten provider/country/etc.
  for (const candidate of candidates.filter((row) => row.depth === 1)) {
    const matchingFamilies = families.filter((family) =>
      family.some((member) => isRefinementOf(member.dimensions, candidate.dimensions)),
    );
    if (matchingFamilies.length === 1) matchingFamilies[0]!.push(candidate);
    else if (matchingFamilies.length === 0) families.push([candidate]);
  }
  return families;
}

export function selectCanonicalWinner(family: Candidate[]): Candidate {
  return [...family].sort((left, right) => {
    const leftIsolated = left.isolatedUnseenDimension !== null;
    const rightIsolated = right.isolatedUnseenDimension !== null;
    if (leftIsolated !== rightIsolated) return rightIsolated ? 1 : -1;
    const leftDescendants = family.filter(
      (member) => member !== left && isRefinementOf(member.dimensions, left.dimensions),
    );
    const rightDescendants = family.filter(
      (member) => member !== right && isRefinementOf(member.dimensions, right.dimensions),
    );
    const leftBranches = containsConflictingSiblings(leftDescendants);
    const rightBranches = containsConflictingSiblings(rightDescendants);
    if (leftBranches !== rightBranches) return rightBranches ? 1 : -1;
    if (!leftBranches && !rightBranches) {
      return (
        right.depth - left.depth ||
        right.confidence - left.confidence ||
        right.attempts - left.attempts ||
        left.segmentKey.localeCompare(right.segmentKey)
      );
    }
    const leftCoverage = leftDescendants.length + 1;
    const rightCoverage = rightDescendants.length + 1;
    const leftScore = leftCoverage * left.depth;
    const rightScore = rightCoverage * right.depth;
    return (
      rightScore - leftScore ||
      right.attempts - left.attempts ||
      right.confidence - left.confidence ||
      left.depth - right.depth ||
      left.segmentKey.localeCompare(right.segmentKey)
    );
  })[0]!;
}

export function evaluateUnseenChildIsolation(
  target: Candidate,
  evaluated: Candidate[],
  minSampleSize: number,
) {
  if (!target.baseline.source.startsWith('ancestor_') || target.attempts < minSampleSize) {
    return noIsolation();
  }
  const inherited = (Object.keys(target.dimensions) as Dimension[]).filter(
    (dimension) => target.baseline.matchedDimensions[dimension] === undefined,
  );
  if (inherited.length !== 1 || target.drop < 0.2) return noIsolation();
  const dimension = inherited[0]!;
  const siblings = evaluated.filter(
    (candidate) =>
      candidate !== target &&
      candidate.depth === target.depth &&
      candidate.attempts >= minSampleSize &&
      candidate.dimensions[dimension] !== undefined &&
      candidate.dimensions[dimension] !== target.dimensions[dimension] &&
      sameDimensionsExcept(target.dimensions, candidate.dimensions, dimension) &&
      candidate.observedRate >= target.baseline.expectedRate - Math.max(0.05, target.baseline.variance * 2),
  );
  const ancestor = evaluated.find(
    (candidate) =>
      candidate.segmentKey === target.baseline.matchedSegmentKey ||
      sameDimensions(candidate.dimensions, target.baseline.matchedDimensions),
  );
  const dominatesAncestor = ancestor !== undefined && target.attempts / ancestor.attempts >= 0.5;
  if (siblings.length < 2 || !dominatesAncestor) return noIsolation();
  return {
    isolated: true,
    dimension,
    healthySiblingValues: siblings
      .sort((left, right) => right.attempts - left.attempts)
      .slice(0, 3)
      .map((candidate) => candidate.dimensions[dimension]!),
  };
}

function noIsolation() {
  return { isolated: false, dimension: null, healthySiblingValues: [] as string[] };
}

function sameDimensionsExcept(a: DimensionMap, b: DimensionMap, excluded: Dimension) {
  return (Object.keys(a) as Dimension[]).every(
    (dimension) => dimension === excluded || a[dimension] === b[dimension],
  );
}

function sameDimensions(a: DimensionMap, b: DimensionMap) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as Dimension[]);
  return [...keys].every((dimension) => a[dimension] === b[dimension]);
}

function containsConflictingSiblings(candidates: Candidate[]) {
  return candidates.some((candidate, index) =>
    candidates.slice(index + 1).some((other) => conflicts(candidate.dimensions, other.dimensions)),
  );
}

/**
 * Anclaje estable: la dimension individual con la señal mas fuerte dentro
 * del diagnostico. No cambia cuando el diagnostico se afina, asi que sirve
 * para reconocer el mismo incidente entre corridas.
 */
export function anchorFor(winner: Candidate, _all: Candidate[], _winners: Candidate[] = [winner]): string {
  return winner.segmentKey;
}

export function stableFamilyAnchor(family: Candidate[], winner: Candidate) {
  const isolatedDimension = winner.isolatedUnseenDimension;
  if (!isolatedDimension) {
    const ancestors = family.filter(
      (candidate) =>
        candidate !== winner &&
        candidate.depth >= 2 &&
        isRefinementOf(winner.dimensions, candidate.dimensions),
    );
    return ancestors.length > 0
      ? [...ancestors].sort(
          (left, right) =>
            right.depth - left.depth ||
            right.confidence - left.confidence ||
            left.segmentKey.localeCompare(right.segmentKey),
        )[0]!.segmentKey
      : winner.segmentKey;
  }
  const parentProjections = family.filter(
    (candidate) => candidate.dimensions[isolatedDimension] === undefined,
  );
  return parentProjections.length > 0
    ? selectCanonicalWinner(parentProjections).segmentKey
    : winner.baseline.matchedSegmentKey ?? winner.segmentKey;
}

export type ActiveIncidentLineage = {
  id: string;
  anchorFingerprint: string;
  fingerprint: string;
  startedAt: Date;
  diagnoses: Array<{ dimensions: unknown }>;
};

export function resolveExistingIncident(input: {
  proposedAnchor: string;
  winner: Candidate;
  family: Candidate[];
  activeIncidents: ActiveIncidentLineage[];
}): ActiveIncidentLineage | null {
  const exact = input.activeIncidents.filter(
    (incident) => incident.anchorFingerprint === input.proposedAnchor,
  );
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) return null;

  const currentDimensions = [input.winner, ...input.family].map((candidate) => candidate.dimensions);
  const compatible = input.activeIncidents.filter((incident) => {
    const previousDimensions = [
      dimensionsFromUnknown(incident.diagnoses[0]?.dimensions),
      dimensionsFromSegmentKey(incident.fingerprint),
      dimensionsFromSegmentKey(incident.anchorFingerprint),
    ].filter(
      (dimensions) =>
        // Un ancla de una sola dimension sirve como exact match, pero es
        // demasiado general para reasignar lineage entre corridas.
        Object.keys(dimensions).length >= 2,
    );
    return previousDimensions.some((previous) =>
      currentDimensions.some(
        (current) =>
          isRefinementOf(current, previous) || isRefinementOf(previous, current),
      ),
    );
  });
  return compatible.length === 1 ? compatible[0]! : null;
}

function dimensionsFromUnknown(value: unknown): DimensionMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [Dimension, string] =>
        DIMENSIONS.includes(entry[0] as Dimension) && typeof entry[1] === 'string',
    ),
  );
}

function dimensionsFromSegmentKey(segmentKey: string): DimensionMap {
  return dimensionsFromUnknown(
    Object.fromEntries(
      segmentKey.split('|').map((part) => {
        const separator = part.indexOf('=');
        return separator < 1 ? ['', ''] : [part.slice(0, separator), part.slice(separator + 1)];
      }),
    ),
  );
}

export function sameCandidateFamily(a: Candidate, b: Candidate, all: Candidate[]): boolean {
  return groupAnomalyFamilies(all).some(
    (family) => family.includes(a) && family.includes(b),
  );
}

function sharedDimensionCount(a: DimensionMap, b: DimensionMap) {
  return Object.entries(a).filter(([key, value]) => b[key as Dimension] === value).length;
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

export function alertRoutingFingerprint(
  fingerprint: string,
  declineReasons: DeclineReasonRow[],
  concentrationThreshold = 0.6,
) {
  if (fingerprint.split('|').some((part) => part.startsWith('failureReason='))) {
    return fingerprint;
  }

  const [dominant] = declineReasons;
  if (!dominant || dominant.shareOfDeclines < concentrationThreshold) {
    return fingerprint;
  }

  return buildSegmentKey({
    ...Object.fromEntries(
      fingerprint
        .split('|')
        .map((part) => {
          const separator = part.indexOf('=');
          return separator > 0
            ? [part.slice(0, separator), part.slice(separator + 1)]
            : null;
        })
        .filter((entry): entry is [string, string] => entry !== null),
    ),
    failureReason: dominant.code,
  } as DimensionMap);
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
  const unseen = winner.isolatedUnseenDimension
    ? [{
        dimension: winner.isolatedUnseenDimension,
        dimensionValue: winner.dimensions[winner.isolatedUnseenDimension]!,
        baselineRate: winner.baseline.expectedRate,
        observedRate: winner.observedRate,
        difference: winner.drop,
        attempts: winner.attempts,
        confidence: winner.rootCauseConfidence,
        isRootCause: true,
      }]
    : [];
  return deduplicateEvidence([direct, ...unseen, ...affected, ...controls, ...declines]).slice(0, 8);
}

function deduplicateEvidence<T extends {
  dimension: string;
  dimensionValue: string;
  isRootCause: boolean;
  confidence: number;
  attempts: number;
  difference: number;
}>(rows: T[]): T[] {
  const strongest = new Map<string, T>();
  for (const row of rows) {
    const key = `${row.dimension}\u0000${row.dimensionValue}\u0000${row.isRootCause}`;
    const current = strongest.get(key);
    if (
      !current ||
      row.confidence > current.confidence ||
      (row.confidence === current.confidence && row.attempts > current.attempts) ||
      (row.confidence === current.confidence &&
        row.attempts === current.attempts &&
        Math.abs(row.difference) > Math.abs(current.difference))
    ) {
      strongest.set(key, row);
    }
  }
  return [...strongest.values()];
}

function safeError(error: unknown) {
  return error instanceof Error ? error.message : 'Unknown error';
}

export async function bestEffort(
  action: () => Promise<unknown>,
  onError: (error: unknown) => void,
) {
  try {
    await action();
    return true;
  } catch (error) {
    onError(error);
    return false;
  }
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
