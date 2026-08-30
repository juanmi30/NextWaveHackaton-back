const configuredUrl = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const apiUrl = configuredUrl.endsWith('/api') ? configuredUrl : `${configuredUrl}/api`;

async function request(path, options = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...options.headers },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${path} failed (${response.status}): ${JSON.stringify(payload)}`);
  return payload;
}

const get = (path) => request(path);
const post = (path, body) =>
  request(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const remove = (path) => request(path, { method: 'DELETE' });

async function waitUntil(check, { timeoutMs = 30_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms; last result=${JSON.stringify(last)}`);
}

async function main() {
  console.log(`Running live regression against ${apiUrl}`);
  await post('/demo/seed?reset=true&historyHours=72&density=5');
  await post('/live/start', {
    tickIntervalMs: 500,
    transactionsPerTick: 80,
    detectionIntervalMs: 3_000,
    detectionWindowMinutes: 5,
    randomSeed: 1_337,
  });
  const running = await get('/live/status');
  if (running.state !== 'RUNNING') throw new Error('Live monitor did not start');
  console.log('[PASS] Live monitor started');

  await waitUntil(async () => {
    const status = await get('/live/status');
    return status.generator.generatedTransactions > 0 && status;
  });
  console.log('[PASS] Transactions streaming');

  await waitUntil(async () => {
    const status = await get('/live/status');
    return status.detection.runs >= 2 && status;
  });
  console.log('[PASS] Automatic detection running');
  const quietIncidents = await get('/incidents?status=OPEN');
  if (quietIncidents.length !== 0) throw new Error('Normal live traffic created an unexpected incident');
  console.log('[PASS] Normal traffic remained quiet');

  const degradationA = await post('/live/degradations', {
    dimensions: { provider: 'Adyen', country: 'BR' },
    approvalRate: 0.1,
    durationSeconds: 120,
    failureReason: 'DO_NOT_HONOR',
    targetTransactionsPerTick: 40,
  });
  const firstIncidents = await waitUntil(async () => {
    const incidents = await get('/incidents?status=OPEN');
    return incidents.length === 1 && incidents;
  });
  if (firstIncidents.length !== 1) throw new Error('One partial degradation must create one incident');
  const affectedTraffic = await waitUntil(async () => {
    const rows = await get('/transactions?provider=Adyen&country=BR&limit=200');
    const banks = new Set(rows.map((row) => row.issuingBank));
    const methods = new Set(rows.map((row) => row.method));
    return banks.size >= 2 && methods.size >= 2 && { banks: [...banks], methods: [...methods] };
  });
  if (affectedTraffic.banks.length < 2) throw new Error('Partial target concentrated on one bank');
  console.log('[PASS] Live degradation detected');

  const degradationB = await post('/live/degradations', {
    dimensions: { provider: 'Stripe', country: 'MX' },
    approvalRate: 0.12,
    durationSeconds: 120,
    failureReason: 'PROVIDER_ERROR',
    targetTransactionsPerTick: 40,
  });
  await waitUntil(async () => {
    const incidents = await get('/incidents?status=OPEN');
    return incidents.length === 2 && incidents;
  });
  console.log('[PASS] Two simultaneous degradations separated');

  const trial = await post('/live/degradations', {
    dimensions: {
      merchant: 'PagoTotal Retail',
      provider: 'Adyen',
      method: 'CARD',
      country: 'BR',
      issuingBank: 'BancoJudgeUnseen',
    },
    approvalRate: 0.15,
    durationSeconds: 60,
    targetTransactionsPerTick: 20,
  });
  await waitUntil(async () => {
    const rows = await get('/transactions?issuingBank=BancoJudgeUnseen&limit=20');
    return rows.length > 0 && rows;
  });
  console.log('[PASS] Trial-by-fire target generated');

  await Promise.all([
    remove(`/live/degradations/${degradationA.id}`),
    remove(`/live/degradations/${degradationB.id}`),
    remove(`/live/degradations/${trial.id}`),
  ]);
  await post('/live/stop');
  const stopped = await get('/live/status');
  if (stopped.state !== 'STOPPED') throw new Error('Live monitor did not stop');
  console.log('[PASS] Monitor stopped cleanly');
}

main().catch(async (error) => {
  try {
    await post('/live/stop');
  } catch {}
  console.error(`[FAIL] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
