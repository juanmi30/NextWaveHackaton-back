const configuredUrl = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const apiUrl = configuredUrl.endsWith('/api') ? configuredUrl : `${configuredUrl}/api`;

async function post(path, body) {
  const response = await fetch(`${apiUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${path} returned non-JSON (${response.status}): ${text.slice(0, 200)}`);
  }
  if (!response.ok) throw new Error(`${path} failed (${response.status}): ${JSON.stringify(payload)}`);
  return payload;
}

async function get(path) {
  const response = await fetch(`${apiUrl}${path}`);
  const payload = await response.json();
  if (!response.ok) throw new Error(`${path} failed (${response.status}): ${JSON.stringify(payload)}`);
  return payload;
}

function assert(condition, message, payload) {
  if (!condition) throw new Error(`${message}\nReceived: ${JSON.stringify(payload, null, 2)}`);
}

async function seed() {
  return post('/demo/seed?reset=true&historyHours=72&density=5');
}

async function detect(overrides = {}) {
  return post('/detection/run', {
    windowMinutes: 15,
    maxDepth: 3,
    minSampleSize: 20,
    ...overrides,
  });
}

async function scenarioNormal() {
  await seed();
  const result = await detect();
  assert(result.outcome === 'NO_ANOMALY', 'Normal traffic must be NO_ANOMALY', result);
  console.log('[PASS] Normal traffic -> NO_ANOMALY');
}

async function scenarioSingleIncident() {
  await seed();
  await post('/demo/inject-incident', {
    provider: 'Adyen',
    country: 'BR',
    approvalRate: 0.25,
    transactionsPerMinute: 30,
  });
  const result = await detect();
  assert(
    result.outcome === 'INCIDENTS_FOUND' && result.incidents.length >= 1,
    'Single degradation must create at least one incident',
    result,
  );
  console.log(`[PASS] Single incident -> ${result.incidents.length} incident(s)`);
}

async function scenarioSimultaneousIncidents() {
  await seed();
  await post('/demo/inject-incident', {
    provider: 'Adyen',
    country: 'BR',
    approvalRate: 0.2,
    transactionsPerMinute: 30,
  });
  await post('/demo/inject-incident', {
    provider: 'Adyen',
    country: 'MX',
    approvalRate: 0.2,
    transactionsPerMinute: 30,
  });
  const result = await detect();
  const anchors = new Set(result.incidents.map((incident) => incident.anchorFingerprint));
  assert(
    result.outcome === 'INCIDENTS_FOUND' && result.incidents.length >= 2 && anchors.size >= 2,
    'Simultaneous degradations must produce at least two distinct anchored stories',
    result,
  );
  console.log('[PASS] Simultaneous incidents -> distinct stories');
  for (const incident of result.incidents) {
    console.log(`       fingerprint=${incident.fingerprint} anchor=${incident.anchorFingerprint}`);
  }
}

async function scenarioMultiIncidentConcierge() {
  if (!process.env.OPENAI_API_KEY) {
    console.log('[SKIP] Multi-incident agent -> OPENAI_API_KEY not configured');
    return;
  }
  const result = await post('/agent/incidents/analyze-active', { limit: 10 });
  const ranks = new Set(result.incidents.map((incident) => incident.priorityRank));
  const incidentIds = new Set(result.incidents.map((incident) => incident.incidentId));
  assert(
    result.portfolio.activeIncidentCount >= 2 &&
      result.incidents.length >= 2 &&
      ranks.size >= 2 &&
      incidentIds.size >= 2 &&
      result.portfolio.totalLossPerMinuteCents > 0,
    'Multi-incident concierge must prioritize distinct active incidents',
    result,
  );
  console.log(
    `[PASS] Multi-incident concierge -> ${result.incidents.length} incidents prioritized`,
  );
}

async function scenarioTrialByFire() {
  await seed();
  const issuingBank = 'BancoJudgeUnseen';
  await post('/demo/inject-incident', {
    merchant: 'Mercado Uno',
    provider: 'Adyen',
    method: 'CARD',
    country: 'BR',
    issuingBank,
    approvalRate: 0.15,
    transactionsPerMinute: 35,
  });
  const result = await detect();
  const isolated = result.incidents.some((incident) =>
    incident.fingerprint.includes(`issuingBank=${issuingBank}`),
  );
  assert(
    result.outcome === 'INCIDENTS_FOUND' && isolated,
    'Trial-by-fire route must be detected and retain the unseen dimension',
    result,
  );
  console.log('[PASS] Trial by fire -> root cause isolated');
}

async function scenarioInsufficientEvidence() {
  await post('/demo/reset');
  await post('/baselines/rebuild', { lookbackHours: 1, maxDepth: 3, excludeLastMinutes: 60 });
  await post('/demo/inject-incident', {
    merchant: 'NoHistoryMerchant',
    provider: 'NoHistoryProvider',
    method: 'NEW_METHOD',
    country: 'ZZ',
    issuingBank: 'NoHistoryBank',
    approvalRate: 0.1,
    transactionsPerMinute: 25,
  });
  const result = await detect();
  assert(
    result.outcome === 'INSUFFICIENT_EVIDENCE',
    'Traffic without any historical baseline must not be reported as NO_ANOMALY',
    result,
  );
  console.log('[PASS] Insufficient evidence -> admitted uncertainty');
}

async function scenarioNoiseSuppression() {
  await seed();
  await post('/demo/inject-incident', {
    provider: 'Adyen',
    country: 'BR',
    approvalRate: 0.88,
    transactionsPerMinute: 2,
  });
  const result = await detect();
  assert(result.outcome === 'NO_ANOMALY', 'Small fluctuation must be suppressed', result);
  console.log('[PASS] Noise suppression');
}

async function scenarioPersistentConfirmation() {
  await seed();
  await post('/demo/inject-incident', {
    provider: 'Adyen',
    country: 'BR',
    approvalRate: 0.7,
    transactionsPerMinute: 25,
  });
  const first = await detect({ confirmationRuns: 2 });
  const second = await detect({ confirmationRuns: 2 });
  assert(first.outcome !== 'INCIDENTS_FOUND', 'First moderate anomaly must remain unconfirmed', first);
  assert(second.outcome === 'INCIDENTS_FOUND', 'Second moderate anomaly must confirm', second);
  console.log('[PASS] Persistent anomaly confirmation');
}

async function scenarioRecoveryHysteresis() {
  await post('/demo/inject-incident', {
    provider: 'Adyen',
    country: 'BR',
    approvalRate: 1,
    transactionsPerMinute: 120,
  });
  await detect({ recoveryRuns: 2 });
  const afterOne = await get('/incidents?status=OPEN');
  await detect({ recoveryRuns: 2 });
  const afterTwo = await get('/incidents?status=OPEN');
  assert(afterOne.length > 0, 'One healthy run must keep the incident open', afterOne);
  assert(afterTwo.length === 0, 'Sustained recovery must resolve the incident', afterTwo);
  console.log('[PASS] Incident recovery hysteresis');
}

async function scenarioEconomicPriority() {
  await seed();
  await post('/demo/inject-incident', {
    provider: 'Adyen',
    country: 'BR',
    approvalRate: 0.2,
    transactionsPerMinute: 50,
  });
  await post('/demo/inject-incident', {
    provider: 'Stripe',
    country: 'MX',
    approvalRate: 0.4,
    transactionsPerMinute: 20,
  });
  const result = await detect({ confirmationRuns: 1 });
  assert(
    result.incidents.length >= 2 &&
      result.incidents[0].priorityRank === 1 &&
      result.incidents[0].priorityScore >= result.incidents[1].priorityScore,
    'Higher economic impact must receive priority rank 1',
    result,
  );
  console.log('[PASS] Economic prioritization');
}

async function scenarioStableIdentity() {
  await seed();
  await post('/demo/inject-incident', {
    merchant: 'Mercado Uno', provider: 'Adyen', method: 'CARD', country: 'BR',
    issuingBank: 'Bradesco', approvalRate: 0.15, transactionsPerMinute: 40,
  });
  const broadRun = await detect({ confirmationRuns: 1, maxDepth: 2 });
  assert(broadRun.incidents.length >= 1, 'Broad run must create an incident', broadRun);
  const broad = broadRun.incidents[0];
  const refinedRun = await detect({ confirmationRuns: 1, maxDepth: 4 });
  const refined = refinedRun.incidents.find((incident) => incident.incidentId === broad.incidentId);
  assert(
    refined &&
      refined.anchorFingerprint === broad.anchorFingerprint &&
      refined.version > broad.version &&
      refined.fingerprint !== broad.fingerprint,
    'Incident identity must survive diagnosis refinement',
    { broad, refinedRun },
  );
  console.log('[PASS] Incident identity survives diagnosis refinement');
}

async function main() {
  console.log(`Running backend demo regression against ${apiUrl}`);
  await scenarioNormal();
  await scenarioSingleIncident();
  await scenarioSimultaneousIncidents();
  await scenarioMultiIncidentConcierge();
  await scenarioTrialByFire();
  await scenarioInsufficientEvidence();
  await scenarioNoiseSuppression();
  await scenarioPersistentConfirmation();
  await scenarioRecoveryHysteresis();
  await scenarioEconomicPriority();
  await scenarioStableIdentity();
}

main().catch((error) => {
  console.error(`[FAIL] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
