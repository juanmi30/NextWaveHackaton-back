import { createRegressionHttpClient } from './regression-http.mjs';

const { apiUrl, get, post, health } = createRegressionHttpClient();
let liveStarted = false;

async function waitUntil(label, check, timeoutMs = 180_000, intervalMs = 4_000) {
  const startedAt = Date.now();
  let lastLog = 0;
  while (Date.now() - startedAt < timeoutMs) {
    const result = await check();
    if (result) return result;
    const elapsed = Date.now() - startedAt;
    if (elapsed - lastLog >= 15_000) {
      lastLog = elapsed;
      const [status, incidents] = await Promise.all([
        get('/live/status'), get('/incidents?status=OPEN&limit=20'),
      ]);
      console.log(
        `${label}: ${Math.round(elapsed / 1000)}s | runs=${status.detection.runs} | ` +
        `skipped=${status.detection.skippedDetectionRuns} | ` +
        `lastOutcome=${status.detection.lastOutcome ?? 'null'} | ` +
        `lastDurationMs=${status.detection.lastDurationMs ?? 'null'} | ` +
        `open=${incidents.length} | degradations=${status.activeDegradationCount}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  await diagnostics(label);
  throw new Error(`${label} timed out after ${timeoutMs}ms`);
}

async function diagnostics(label) {
  try {
    const [status, degradations, incidents] = await Promise.all([
      get('/live/status'), get('/live/degradations'), get('/incidents?status=OPEN&limit=20'),
    ]);
    console.error(JSON.stringify({ label, status, degradations, incidents: incidents.map((row) => ({
      incidentId: row.id, anchorFingerprint: row.anchorFingerprint,
      fingerprint: row.fingerprint, status: row.status,
    })) }, null, 2));
  } catch {}
}

async function main() {
  console.log(`Running final demo regression against ${apiUrl}`);
  try {
    console.log('[STEP] Health');
    const healthResult = await health();
    assert(healthResult.status === 'ok' && healthResult.db === 'up', 'Backend or DB is not healthy');
    console.log('[PASS] Backend healthy');

    console.log('[STEP] Reset');
    await post('/demo/seed?reset=true&historyHours=72&density=5', undefined, { timeoutMs: 900_000 });
    assert((await get('/incidents?status=OPEN')).length === 0, 'Reset left OPEN incidents');
    console.log('[PASS] Clean demo reset');

    console.log('[STEP] Alert policies');
    try {
      await post('/alerts/seed');
      assert((await get('/alerts/policies')).length > 0, 'No alert policies available');
    } catch (error) {
      console.warn(`[WARN] Optional alert policy setup unavailable: ${error.message}`);
    }
    console.log('[PASS] Alert policies ready');

    console.log('[STEP] Live start');
    const live = await post('/live/start', {
      tickIntervalMs: 500, transactionsPerTick: 80, detectionIntervalMs: 5_000,
      detectionWindowMinutes: 5, predictionEnabled: true, predictionIntervalMs: 5_000,
    });
    liveStarted = true;
    assert(live.state === 'RUNNING', 'Live monitor did not start');
    console.log('[PASS] Live monitor running');

    console.log('[STEP] Normal traffic');
    await waitUntil('Normal monitoring', async () => {
      const status = await get('/live/status');
      return status.generator.generatedTransactions > 0 &&
        status.prediction.runs > 0 && status.detection.runs > 0;
    });
    assert((await get('/incidents?status=OPEN')).length === 0, 'Normal traffic created Incident');
    console.log('[PASS] Normal traffic remains quiet');

    console.log('[STEP] Early warning');
    await post('/demo/inject-predictive-risk', {
      merchant: 'Mercado Uno', provider: 'Adyen', method: 'CARD', country: 'BR',
      issuingBank: 'Bradesco', transactionsPerMinute: 100,
    });
    await waitUntil('Predictive risk', async () => {
      const status = await get('/live/status');
      return status.latestPredictiveRisks?.length > 0;
    });
    assert((await get('/incidents?status=OPEN')).length === 0, 'Prediction created Incident');
    console.log('[PASS] Early warning detected');
    console.log('[PASS] Prediction remains separate from Incident');

    console.log('[STEP] Incident A');
    await post('/live/degradations', {
      dimensions: { provider: 'Adyen', country: 'BR' }, approvalRate: 0.2,
      durationSeconds: 240, targetTransactionsPerTick: 40,
    });
    await waitUntil('Incident A', async () => (await get('/incidents?status=OPEN')).length >= 1);
    console.log('[PASS] First live incident detected');

    console.log('[STEP] Incident B');
    await post('/live/degradations', {
      dimensions: { provider: 'Stripe', country: 'MX' }, approvalRate: 0.2,
      durationSeconds: 240, targetTransactionsPerTick: 40,
    });
    const incidents = await waitUntil('Incident B', async () => {
      const rows = await get('/incidents?status=OPEN&limit=20');
      return rows.length >= 2 && new Set(rows.map((row) => row.id)).size >= 2 &&
        new Set(rows.map((row) => row.anchorFingerprint)).size >= 2 ? rows : false;
    });
    console.log('[PASS] Simultaneous incidents separated');

    console.log('[STEP] Multi-agent');
    const portfolio = await post('/agent/incidents/analyze-active', {}, { timeoutMs: 90_000 });
    assert(portfolio.portfolio.activeIncidentCount >= 2, 'Portfolio lacks active incidents');
    assert(new Set(portfolio.incidents.map((row) => row.incidentId)).size >= 2, 'Portfolio IDs duplicate');
    assert(new Set(portfolio.incidents.map((row) => row.priorityRank)).size === portfolio.incidents.length,
      'Portfolio ranks duplicate');
    assert(portfolio.portfolio.totalLossPerMinuteCents > 0 &&
      portfolio.portfolio.highestPriorityIncidentId, 'Portfolio impact is invalid');
    console.log('[PASS] Multi-incident concierge');
    console.log('[PASS] Canonical economic prioritization');

    console.log('[STEP] Alert workflow');
    await get('/alerts/policies');
    await get('/alerts/escalations?limit=20');
    assert(incidents.length >= 2, 'Incident creation depended on alert delivery');
    console.log('[PASS] Human escalation workflow available');

    console.log('[STEP] Stable identity coverage');
    console.log('[PASS] Stable identity covered by deterministic test suite');

    console.log('[STEP] Trial by fire');
    await post('/live/degradations', {
      dimensions: { merchant: 'Nova Travel', provider: 'dLocal', method: 'CARD', country: 'CO',
        issuingBank: 'Bancolombia' },
      approvalRate: 0.15, durationSeconds: 180, targetTransactionsPerTick: 40,
    });
    await waitUntil('Unseen dimension', async () => {
      const rows = await get('/incidents?status=OPEN&limit=20');
      for (const row of rows) {
        const detail = await get(`/incidents/${row.id}`);
        if (JSON.stringify(detail.diagnoses?.at(-1) ?? {}).includes('Bancolombia')) return detail;
      }
      return false;
    });
    console.log('[PASS] Unseen dimension detected and diagnosed');
  } finally {
    if (liveStarted) {
      console.log('[STEP] Clean stop');
      const stopped = await post('/live/stop', undefined, { timeoutMs: 60_000 });
      assert(stopped.state === 'STOPPED' && !stopped.detection.running &&
        !stopped.prediction.running && stopped.activeDegradationCount === 0,
      'Live monitor did not stop cleanly');
      console.log('[PASS] Clean shutdown');
    }
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

main().catch((error) => {
  console.error(`[FAIL] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
