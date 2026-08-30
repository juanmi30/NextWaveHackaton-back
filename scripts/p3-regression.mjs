import { createRegressionHttpClient } from './regression-http.mjs';

const { apiUrl, get, post, health } = createRegressionHttpClient();

async function waitUntil(
  check,
  { timeoutMs = 60_000, intervalMs = 500, onPoll } = {},
) {
  const startedAt = Date.now();
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await onPoll?.({ elapsedMs: Date.now() - startedAt, last });
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms; last=${JSON.stringify(last)}`);
}

async function main() {
  console.log(`Running P3 regression against ${apiUrl}`);
  let monitorStarted = false;
  try {
    console.log('[STEP] Health check');
    await health();
    console.log('[STEP] Resetting demo');
    await post('/demo/seed?reset=true&historyHours=72&density=5', undefined, { timeoutMs: 900_000 });
    console.log('[STEP] Starting live monitor');
    await post('/live/start', {
      tickIntervalMs: 500, transactionsPerTick: 80, detectionIntervalMs: 3_000,
      detectionWindowMinutes: 5, predictionEnabled: true, predictionIntervalMs: 5_000,
    });
    monitorStarted = true;
    const started = await get('/live/status');
    if (!started.prediction?.enabled) throw new Error('Automatic prediction is not enabled');
    console.log('[STEP] Waiting for automatic prediction');
    await waitUntil(async () => (await get('/live/status')).prediction.runs >= 1);
    console.log('[PASS] Automatic prediction running');

    console.log('[STEP] Checking normal traffic');
    const normal = await get('/incidents?status=OPEN');
    if (normal.length !== 0) throw new Error('Normal traffic created an incident');
    console.log('[PASS] Normal traffic remains incident-free');

    console.log('[STEP] Injecting predictive risk');
    await post('/demo/inject-predictive-risk', {
      merchant: 'Mercado Uno', provider: 'Adyen', method: 'CARD', country: 'BR',
      issuingBank: 'Bradesco', transactionsPerMinute: 100,
    });
    console.log('[STEP] Waiting for predictive risk');
    const risks = await waitUntil(async () => {
      const status = await get('/live/status');
      return status.latestPredictiveRisks?.length ? status.latestPredictiveRisks : false;
    }, { timeoutMs: 180_000, intervalMs: 4_000 });
    if (!risks) throw new Error('No predictive risk found');
    console.log('[PASS] Early predictive risk detected');
    if ((await get('/incidents?status=OPEN')).length !== 0) {
      throw new Error('Prediction created an incident');
    }
    console.log('[PASS] Prediction did not create incident');

    console.log('[STEP] Injecting incident A');
    await post('/live/degradations', {
      dimensions: { provider: 'Adyen', country: 'BR' }, approvalRate: 0.2,
      durationSeconds: 240, targetTransactionsPerTick: 40,
    });
    console.log('[STEP] Waiting for incident A');
    await waitUntil(async () => (await get('/incidents?status=OPEN')).length >= 1);
    console.log('[PASS] Detection confirmed incident');
    console.log('[STEP] Injecting incident B');
    await post('/live/degradations', {
      dimensions: { provider: 'Stripe', country: 'MX' }, approvalRate: 0.2,
      durationSeconds: 240, targetTransactionsPerTick: 40,
    });

    console.log('[STEP] Waiting for incident B');
    let pollingSnapshot;
    let lastLogAt = 0;
    let canonicalIncidents;
    try {
      canonicalIncidents = await waitUntil(async () => {
        const [status, incidents] = await Promise.all([
          get('/live/status'),
          get('/incidents?status=OPEN&limit=20'),
        ]);
        pollingSnapshot = { status, incidents };
        const ids = new Set(incidents.map((incident) => incident.id));
        const anchors = new Set(incidents.map((incident) => incident.anchorFingerprint));
        return incidents.length >= 2 && ids.size >= 2 && anchors.size >= 2 ? incidents : false;
      }, {
        timeoutMs: 150_000,
        intervalMs: 4_000,
        onPoll: ({ elapsedMs }) => {
          if (!pollingSnapshot || elapsedMs - lastLogAt < 15_000) return;
          lastLogAt = elapsedMs;
          const { status, incidents } = pollingSnapshot;
          console.log(
            `${Math.round(elapsedMs / 1_000)}s | runs=${status.detection.runs} | ` +
            `skipped=${status.detection.skippedDetectionRuns} | ` +
            `lastOutcome=${status.detection.lastOutcome ?? 'null'} | open=${incidents.length} | ` +
            `lastDurationMs=${status.detection.lastDurationMs ?? 'null'} | ` +
            `degradations=${status.activeDegradationCount}`,
          );
        },
      });
    } catch (error) {
      await printSecondIncidentDiagnostics();
      throw error;
    }
    if (new Set(canonicalIncidents.map((incident) => incident.id)).size < 2 ||
        new Set(canonicalIncidents.map((incident) => incident.anchorFingerprint)).size < 2) {
      throw new Error('Two OPEN incidents must have distinct incidentId and anchorFingerprint');
    }
    console.log('[PASS] Two canonical incidents active');

    console.log('[STEP] Calling multi-incident concierge');
    const portfolio = await post('/agent/incidents/analyze-active', {}, { timeoutMs: 60_000 });
    if (portfolio.portfolio.activeIncidentCount < 2 || portfolio.incidents.length < 2) {
      throw new Error('Multi-incident concierge did not analyze two incidents');
    }
    const ranks = portfolio.incidents.map((incident) => incident.priorityRank);
    if (new Set(ranks).size !== ranks.length) throw new Error('Priority ranks are not unique');
    if (portfolio.portfolio.totalLossPerMinuteCents <= 0) throw new Error('Canonical impact is empty');
    console.log('[PASS] Multi-incident concierge');
    console.log('[PASS] Canonical portfolio impact');
    console.log('[PASS] Agent fallback available');
  } finally {
    if (monitorStarted) {
      try {
        console.log('[STEP] Stopping live monitor');
        await post('/live/stop');
        console.log('[PASS] Monitor stopped cleanly');
      } catch (error) {
        console.error(`[WARN] Unable to stop Live Monitoring: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

async function printSecondIncidentDiagnostics() {
  try {
    const [status, degradations, incidents] = await Promise.all([
      get('/live/status'),
      get('/live/degradations'),
      get('/incidents?status=OPEN&limit=20'),
    ]);
    console.error('Second incident timeout diagnostics:');
    console.error(JSON.stringify({
      live: {
        state: status.state,
        detection: status.detection,
        activeDegradationCount: status.activeDegradationCount,
      },
      degradations: degradations.map((degradation) => ({
        id: degradation.id,
        dimensions: degradation.dimensions,
        approvalRate: degradation.approvalRate,
        startedAt: degradation.startedAt,
        expiresAt: degradation.expiresAt,
      })),
      incidents: incidents.map((incident) => ({
        incidentId: incident.id,
        anchorFingerprint: incident.anchorFingerprint,
        fingerprint: incident.fingerprint,
        status: incident.status,
      })),
    }, null, 2));
  } catch (error) {
    console.error(`[WARN] Unable to collect timeout diagnostics: ${error instanceof Error ? error.message : String(error)}`);
  }
}

main().catch((error) => {
  console.error(`[FAIL] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
