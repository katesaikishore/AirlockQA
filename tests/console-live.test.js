import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { chromium } from 'playwright-core';
import { startDashboardServer } from '../src/dashboard/server.js';

setDefaultTimeout(90_000);

const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (fs.existsSync(macChrome) ? macChrome : undefined);
const XSS = '<img src=x onerror="window.__xss = 1">';

let browser;
let server;
let tempRoot;
let origin;

beforeAll(async () => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'airlock-console-live-'));
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
});

// A fresh dashboard server for every test, as tests/dashboard-static.test.js does: a single server shared by the
// whole file stopped accepting connections partway through on Linux CI.
beforeEach(async () => {
  server = startDashboardServer({ compliance: { outputDir: path.join(tempRoot, 'compliance') } }, 0, path.join(tempRoot, 'artifacts'));
  await once(server, 'listening');
  origin = 'http://127.0.0.1:' + server.address().port;
});

afterEach(async () => {
  if (server) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
    server = undefined;
  }
});

afterAll(async () => {
  if (browser) await browser.close();
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Mock of the Airlock Cloud API (shapes from cloud/shared/contract.ts)
// ---------------------------------------------------------------------------

const NOW = Date.now();
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();

function makeRun(overrides) {
  const id = (overrides && overrides.id) || 'run_aaaaaaaa11111111';
  return {
    runId: id,
    id,
    status: 'SUCCESS',
    suiteName: 'checkout',
    targetUrl: 'https://staging.example.com/shop',
    workflowName: 'smoke',
    createdAt: iso(-60_000),
    startedAt: iso(-55_000),
    finishedAt: iso(-50_000),
    executionTimeMs: 5000,
    totalSteps: 2,
    passedSteps: 2,
    failedSteps: 0,
    requestsAllowed: 7,
    requestsBlocked: 1,
    failureReason: null,
    queuePosition: null,
    hasEvidence: true,
    ...overrides,
  };
}

function makeDetail(summary, extra) {
  return {
    ...summary,
    steps: [
      { index: 0, action: 'goto', target: summary.targetUrl, ok: true, detail: 'loaded' },
      { index: 1, action: 'expectVisible', target: '#cart', ok: summary.status !== 'FAILED', error: summary.status === 'FAILED' ? 'Timeout waiting for #cart' : undefined },
    ],
    requests: [
      { timestamp: iso(-54_000), method: 'GET', host: 'staging.example.com', path: '/shop', verdict: 'ALLOWED' },
      { timestamp: iso(-53_000), method: 'POST', host: 'api.stripe.com', path: '/v1/refunds', verdict: 'BLOCKED', reason: 'blocked path' },
    ],
    error: summary.status === 'FAILED' ? 'Step 2 failed' : null,
    evidence: summary.hasEvidence
      ? { merkleRoot: 'a'.repeat(64), signature: 'b'.repeat(64), signingAlgorithm: 'Ed25519', keyId: 'key_test_01', blocksCount: 5 }
      : null,
    createdBy: { type: 'session', label: 'console' },
    ...extra,
  };
}

function makeQaRun(overrides) {
  const id = (overrides && overrides.id) || 'run_qa_aaaaaaaa1111';
  return {
    id,
    status: 'FAILED',
    phase: 'TESTS_FAILED',
    repo: 'https://github.com/acme/app',
    sha: 'a'.repeat(40),
    branch: 'main',
    createdAt: iso(-120_000),
    finishedAt: iso(-60_000),
    suites: [{ suite: 'explore', status: 'FAIL' }],
    gate: { exitCode: 1, reasons: ['explore: S2 HTTP 500 from GET /api/stats'] },
    gateMode: 'strict',
    ...overrides,
  };
}

function emptyQaAnalytics(overrides) {
  return {
    runs: 0,
    suiteResults: 0,
    failRate: { failed: 0, total: 0 },
    flakeRate: { flaky: 0, total: 0 },
    hotspots: [],
    findings: [],
    ...(overrides || {}),
  };
}

function usageInfo(used) {
  return {
    plan: 'free',
    daily: { scope: 'workspace', used, limit: 100, remaining: 100 - used, resetAt: '2026-11-08T00:00:00.000Z' },
    concurrent: { limit: 1, running: 0, queued: 0 },
    limits: { maxSteps: 50, runTimeoutSec: 90, maxActiveKeys: 10 },
  };
}

function createMock(options) {
  const mock = {
    user: options && options.signedOut ? null : { id: 'usr_1', email: 'maya@example.com', name: 'Maya' },
    workspace: { id: 'ws_1', name: 'Acme QA', plan: 'free', createdAt: iso(-86_400_000 * 5), limits: { dailyRuns: 100 } },
    used: 12,
    runs: [],
    qaRuns: [],
    qaAnalytics: emptyQaAnalytics(),
    details: new Map(),
    keys: [],
    calls: [],
    createStatus: null,
    createBody: null,
    verifyResults: {},
    handlers: {},
    ...(options || {}),
  };
  return mock;
}

async function installMock(context, mock) {
  // Nothing but the local server is reachable: fonts and CDN modules are aborted fast.
  await context.route((url) => url.hostname !== '127.0.0.1', (route) => route.abort());
  await context.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const apiPath = url.pathname.replace(/^\/api/, '');
    const method = request.method();
    mock.calls.push(method + ' ' + apiPath);
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: body === undefined ? '' : JSON.stringify(body) });

    if (mock.handlers[method + ' ' + apiPath]) return mock.handlers[method + ' ' + apiPath](route, { json, url, request });
    if (apiPath === '/checkpoints') return json(200, []);
    if (apiPath === '/v1/auth/me') {
      return mock.user ? json(200, { user: mock.user, workspace: mock.workspace }) : json(401, { code: 'UNAUTHENTICATED', message: 'Sign in first' });
    }
    if (apiPath === '/v1/auth/logout' && method === 'POST') { mock.user = null; return json(204); }
    if (apiPath === '/v1/usage') return json(200, usageInfo(mock.used));
    if (apiPath === '/v1/workspace' && method === 'GET') return json(200, mock.workspace);
    if (apiPath === '/v1/workspace' && method === 'PATCH') {
      mock.workspace = { ...mock.workspace, name: JSON.parse(request.postData() || '{}').name };
      return json(200, mock.workspace);
    }
    if (apiPath === '/v1/qa-runs' && method === 'GET') return json(200, { runs: mock.qaRuns || [] });
    if (apiPath === '/v1/qa-analytics') return json(200, mock.qaAnalytics || emptyQaAnalytics());
    if (apiPath === '/v1/analytics') {
      const days = Number(url.searchParams.get('days') || 30);
      const list = [];
      for (let index = days - 1; index >= 0; index -= 1) {
        const date = new Date(NOW - index * 86400000).toISOString().slice(0, 10);
        list.push({ date, runs: index === 0 ? 4 : 0, success: index === 0 ? 3 : 0, failed: index === 0 ? 1 : 0 });
      }
      return json(200, { days: list, totals: { runs: 4, passRate: 0.75, medianMs: 4200, requestsAllowed: 31, requestsBlocked: 6 } });
    }
    if (apiPath === '/v1/runs' && method === 'GET') {
      const status = url.searchParams.get('status');
      const runs = mock.runs.filter((run) => !status || run.status === status);
      return json(200, { runs: runs.slice(0, Number(url.searchParams.get('limit') || 50)), nextCursor: null });
    }
    if (apiPath === '/v1/runs' && method === 'POST') {
      mock.createBody = JSON.parse(request.postData() || '{}');
      if (mock.createStatus === 429) {
        return json(429, { code: 'DAILY_QUOTA_EXCEEDED', message: 'Daily run limit reached', quota: { scope: 'workspace', used: 100, limit: 100, remaining: 0, resetAt: '2026-11-08T00:00:00.000Z' } });
      }
      if (mock.createStatus === 400) {
        return json(400, { code: 'INVALID_REQUEST', message: 'Invalid request', issues: [{ path: 'targetUrl', message: 'Invalid url' }] });
      }
      mock.used += 1;
      const created = makeRun({ id: 'run_new00000001', status: 'QUEUED', suiteName: mock.createBody.suiteName, targetUrl: mock.createBody.targetUrl, queuePosition: 1, startedAt: null, finishedAt: null, executionTimeMs: null, totalSteps: 0, passedSteps: 0, hasEvidence: false });
      mock.runs.unshift(created);
      return json(202, { runId: created.id, id: created.id, status: 'QUEUED', queuePosition: 1, quota: usageInfo(mock.used).daily });
    }
    const runMatch = /^\/v1\/runs\/([^/]+)(\/evidence|\/cancel)?$/.exec(apiPath);
    if (runMatch) {
      const id = decodeURIComponent(runMatch[1]);
      const summary = mock.runs.find((run) => run.id === id);
      if (!summary) return json(404, { code: 'NOT_FOUND', message: 'Run not found' });
      if (runMatch[2] === '/evidence') return json(200, { bundleVersion: '2.0.0', runId: id });
      if (runMatch[2] === '/cancel') {
        summary.status = 'CANCELLED';
        summary.queuePosition = null;
        mock.used -= 1;
        return json(200, makeDetail(summary));
      }
      return json(200, mock.details.get(id) || makeDetail(summary));
    }
    if (apiPath === '/v1/evidence-key') return json(200, { algorithm: 'Ed25519', keyId: 'key_test_01', publicKeyPem: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEATESTKEY\n-----END PUBLIC KEY-----\n' });
    if (apiPath === '/v1/evidence/verify') {
      const bundle = JSON.parse(request.postData() || '{}');
      return json(200, mock.verifyResults[bundle.runId] || { valid: true, warnings: [] });
    }
    if (apiPath === '/v1/keys' && method === 'GET') return json(200, { keys: mock.keys });
    if (apiPath === '/v1/keys' && method === 'POST') {
      const body = JSON.parse(request.postData() || '{}');
      const key = { id: 'key_' + (mock.keys.length + 1), name: body.name, prefix: 'air_live_ab12', createdAt: iso(0), lastUsedAt: null, revokedAt: null };
      mock.keys.push(key);
      return json(201, { key, token: 'air_live_SECRETTOKEN0123456789' });
    }
    const qaMatch = /^\/v1\/qa-runs\/([^/]+)$/.exec(apiPath);
    if (qaMatch && method === 'GET') {
      const run = (mock.qaRuns || []).find((item) => item.id === qaMatch[1]);
      if (!run) return json(404, { code: 'NOT_FOUND', message: 'QA run not found' });
      return json(200, { ...run, evidence: null, findings: [] });
    }
    const keyMatch = /^\/v1\/keys\/([^/]+)$/.exec(apiPath);
    if (keyMatch && method === 'DELETE') {
      mock.keys = mock.keys.filter((key) => key.id !== keyMatch[1]);
      return json(204);
    }
    return json(404, { code: 'NOT_FOUND', message: 'Unknown route ' + apiPath });
  });
}

async function openConsole(mock, hash, config, basePath = '/console') {
  const context = await browser.newContext(config && config.demo ? {} : {});
  if (config && config.demo) {
    await context.addInitScript(() => { window.sessionStorage.setItem('airlock-demo-session', 'preview'); });
  }
  await installMock(context, mock);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin + basePath + (hash || ''));
  return { context, page, errors };
}

async function withConsole(mock, hash, config, check) {
  const session = await openConsole(mock, hash, config);
  try {
    await check(session.page, session);
  } finally {
    await session.context.close();
  }
}

/** The built React console is served at /app; /console is the legacy page in the local server. */
async function withApp(mock, hash, check) {
  const session = await openConsole(mock, hash, undefined, '/app');
  try {
    await check(session.page, session);
  } finally {
    await session.context.close();
  }
}

// ---------------------------------------------------------------------------

describe('Console modes', () => {
  it('redirects to /login with the requested path when nobody is signed in', async () => {
    const mock = createMock({ signedOut: true });
    await withConsole(mock, '#runs', undefined, async (page) => {
      await page.waitForURL(/\/login\?next=/);
      const next = new URL(page.url()).searchParams.get('next');
      expect(next).toBe('/console#runs');
    });
  });

  it('keeps sample mode working with a visible Sample data banner and no run calls', async () => {
    const mock = createMock({ signedOut: true });
    await withConsole(mock, '', { demo: true }, async (page) => {
      await page.waitForSelector('#sample-banner:not([hidden])');
      expect(await page.locator('#sample-banner').innerText()).toContain('Sample data');
      expect(await page.locator('h1', { hasText: 'Good morning, Maya' }).count()).toBeGreaterThan(0);
      await page.click('a.cn-item[data-nav="runs"]');
      await page.waitForSelector('#view-runs', { state: 'visible' });
      expect(await page.locator('#view-runs').innerText()).toContain('#1043');
      expect(await page.locator('#live-runs').count()).toBe(0);
      expect(mock.calls.filter((call) => call.includes('/v1/runs') || call.includes('/v1/usage'))).toEqual([]);
    });
  });

  it('prefers a signed-in user over a leftover sample session', async () => {
    const mock = createMock();
    await withConsole(mock, '', { demo: true }, async (page) => {
      await page.waitForSelector('#usage-count');
      expect(await page.locator('#sample-banner').isHidden()).toBe(true);
    });
  });

  it('shows workspace, email and real usage as "x / 100" in live mode', async () => {
    const mock = createMock();
    await withConsole(mock, '', undefined, async (page, session) => {
      await page.waitForFunction(() => document.getElementById('usage-count') && document.getElementById('usage-count').textContent === '12 / 100');
      expect(await page.locator('#ws-name').innerText()).toBe('Acme QA');
      expect(await page.locator('#signed-in-email').innerText()).toBe('maya@example.com');
      expect(await page.locator('#usage-reset').innerText()).toContain('Resets at');
      expect(await page.locator('#usage-bar').evaluate((element) => element.style.width)).toBe('12%');
      expect(await page.locator('body').innerText()).not.toContain('Maya Chen');
      expect(await page.locator('body').innerText()).not.toContain('Manage billing');
      expect(session.errors).toEqual([]);
    });
  });

  it('shows an empty-state with the CLI commands for a new account', async () => {
    const mock = createMock({ runs: [] });
    mock.handlers['GET /v1/analytics'] = (route, { json }) => json(200, { days: [], totals: { runs: 0, passRate: null, medianMs: null, requestsAllowed: 0, requestsBlocked: 0 } });
    await withConsole(mock, '', undefined, async (page) => {
      await page.waitForSelector('.lv-onboard');
      const text = await page.locator('.lv-onboard').innerText();
      expect(text).toContain('Start a cloud run');
      expect(text).toContain('airlock login');
      expect(text).toContain('airlock test --cloud');
    });
  });

  it('shows QA runs and findings when there are no workflow runs', async () => {
    const mock = createMock({
      runs: [],
      qaRuns: [makeQaRun()],
      qaAnalytics: emptyQaAnalytics({
        runs: 2,
        suiteResults: 4,
        failRate: { failed: 2, total: 4 },
        hotspots: [{ suite: 'explore', failures: 2 }],
        findings: [{ fingerprint: 'fp_qa_1', firstSeenSha: 'a'.repeat(40), buildsOpen: 2, klass: 'http_5xx', severity: 'S2', assertion: 'HTTP 500 from GET /api/stats', route: '/dashboard' }],
      }),
    });
    mock.handlers['GET /v1/analytics'] = (route, { json }) => json(200, { days: [], totals: { runs: 0, passRate: null, medianMs: null, requestsAllowed: 0, requestsBlocked: 0 } });
    await withApp(mock, '', async (page, session) => {
      await page.waitForSelector('#ov-qa-findings-table');
      expect(await page.locator('.lv-onboard').count()).toBe(0);
      const recent = await page.locator('#ov-recent').innerText();
      expect(recent).toContain('QA run');
      expect(recent).toContain('github.com/acme/app');
      const findings = await page.locator('#ov-qa-findings').innerText();
      expect(findings).toContain('HTTP 500 from GET /api/stats');
      expect(findings).toContain('S2');
      const text = await page.locator('#live-dashboard').innerText();
      expect(text).toContain('QA findings');
      expect(text).toContain('50%');
    });
  });

  it('Runs points to the QA screen when the workspace has QA runs but no workflow runs', async () => {
    const mock = createMock({ runs: [], qaRuns: [makeQaRun()] });
    mock.handlers['GET /v1/analytics'] = (route, { json }) => json(200, { days: [], totals: { runs: 0, passRate: null, medianMs: null, requestsAllowed: 0, requestsBlocked: 0 } });
    await withApp(mock, '#runs', async (page) => {
      await page.waitForSelector('#run-empty-state');
      const text = await page.locator('#run-empty-state').innerText();
      expect(text).toContain('No cloud workflow runs yet');
      expect(text).toContain('1 recent QA run');
      expect(await page.locator('#run-empty-state a[href="#qa"]').count()).toBeGreaterThan(0);
      expect(await page.locator('#run-qa-preview').innerText()).toContain('QA run');
    });
  });

  it('Runs has a QA tab with the full QA table', async () => {
    const mock = createMock({ runs: [], qaRuns: [makeQaRun()] });
    await withApp(mock, '#runs', async (page) => {
      await page.click('[data-run-tab="qa"]');
      await page.waitForSelector('#qa-run-table-runs');
      const text = await page.locator('#qa-run-table-runs').innerText();
      expect(text).toContain('acme/app');
      expect(text).toContain('run_qa_aaaaaaaa1111');
      expect(text).toContain('Failed');
      expect(text).toContain('explore');
    });
  });

  it('Evidence lists the sealed QA runs', async () => {
    const mock = createMock({ runs: [], qaRuns: [makeQaRun()] });
    await withApp(mock, '#evidence', async (page) => {
      await page.waitForSelector('#qa-evidence-list');
      const text = await page.locator('#qa-evidence-list').innerText();
      expect(text).toContain('QA run');
      expect(text).toContain('No sealed result');
      expect(text).toContain('acme/app');
    });
  });

  it('shows QA analytics on the Analytics page', async () => {
    const mock = createMock({
      runs: [],
      qaRuns: [makeQaRun()],
      qaAnalytics: emptyQaAnalytics({
        runs: 1,
        suiteResults: 1,
        failRate: { failed: 1, total: 1 },
        findings: [{ fingerprint: 'fp_qa_2', firstSeenSha: 'a'.repeat(40), buildsOpen: 1, klass: 'console_error', severity: 'S3', assertion: 'console error on reports', route: '/reports' }],
      }),
    });
    await withApp(mock, '#analytics', async (page) => {
      await page.waitForSelector('#qa-analytics-content');
      const qa = await page.locator('#qa-analytics').innerText();
      expect(qa).toContain('QA analytics');
      expect(qa).toContain('console error on reports');
      expect(await page.locator('#analytics-qa-note').innerText()).toContain('separate stream');
    });
  });

  it('computes overview KPIs from analytics and lists recent runs', async () => {
    const mock = createMock({ runs: [makeRun({ id: 'run_ov000000001', suiteName: 'overview-suite' })] });
    await withConsole(mock, '', undefined, async (page) => {
      await page.waitForSelector('.lv-recent-link');
      const text = await page.locator('#live-dashboard').innerText();
      expect(text).toContain('overview-suite');
      expect(text).toContain('75%');
      expect(text).toContain('31');
    });
  });
});

describe('Runs', () => {
  it('renders the runs table from the API and polls a QUEUED run until it succeeds', async () => {
    const queued = makeRun({ id: 'run_poll0000001', status: 'QUEUED', suiteName: 'polling-suite', queuePosition: 2, startedAt: null, finishedAt: null, executionTimeMs: null, totalSteps: 0, passedSteps: 0, hasEvidence: false });
    const done = makeRun({ id: 'run_done0000001', status: 'FAILED', suiteName: 'failed-suite', failedSteps: 1, failureReason: 'STEP_FAILED' });
    const mock = createMock({ runs: [queued, done] });
    let listCalls = 0;
    mock.handlers['GET /v1/runs'] = (route, { json }) => {
      listCalls += 1;
      if (listCalls >= 3) {
        mock.runs[0] = makeRun({ id: 'run_poll0000001', status: 'SUCCESS', suiteName: 'polling-suite' });
      }
      return json(200, { runs: mock.runs, nextCursor: null });
    };
    await withConsole(mock, '#runs', undefined, async (page) => {
      await page.waitForSelector('tr[data-run-id="run_poll0000001"]');
      expect(await page.locator('tr[data-run-id="run_poll0000001"]').innerText()).toContain('Queued');
      expect(await page.locator('tr[data-run-id="run_poll0000001"]').innerText()).toContain('Position 2');
      expect(await page.locator('tr[data-run-id="run_done0000001"]').innerText()).toContain('Failed');
      await page.waitForFunction(() => {
        const row = document.querySelector('tr[data-run-id="run_poll0000001"]');
        return row && row.textContent.includes('Passed');
      }, undefined, { timeout: 20_000 });
      // Nothing is queued any more, so polling stops.
      const settled = mock.calls.filter((call) => call === 'GET /v1/runs').length;
      await page.waitForTimeout(4500);
      expect(mock.calls.filter((call) => call === 'GET /v1/runs').length).toBe(settled);
    });
  });

  it('filters by search text and status', async () => {
    const mock = createMock({ runs: [makeRun({ id: 'run_aaaa0000001', suiteName: 'alpha-suite' }), makeRun({ id: 'run_bbbb0000001', suiteName: 'beta-suite', status: 'FAILED' })] });
    await withConsole(mock, '#runs', undefined, async (page) => {
      await page.waitForSelector('tr[data-run-id="run_bbbb0000001"]');
      await page.fill('#run-search-full', 'alpha');
      expect(await page.locator('tbody tr').count()).toBe(1);
      await page.fill('#run-search-full', '');
      await page.selectOption('#run-status-filter-full', 'FAILED');
      await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1);
      expect(await page.locator('tbody tr').innerText()).toContain('beta-suite');
    });
  });

  it('starts a run, validates workflow JSON on the client and refreshes usage', async () => {
    const mock = createMock({ runs: [] });
    await withConsole(mock, '#runs/new', undefined, async (page, session) => {
      await page.waitForSelector('#start-run-form', { state: 'visible' });
      await page.fill('#start-suite', 'smoke-suite');
      await page.fill('#start-target', 'https://staging.example.com');
      await page.fill('#start-workflow', '{ not json');
      await page.click('#start-run-form button[type="submit"]');
      await page.waitForSelector('#start-workflow-error:not([hidden])');
      expect(await page.locator('#start-workflow-error').innerText()).toContain('not valid JSON');
      expect(mock.createBody).toBeNull();

      await page.fill('#start-workflow', JSON.stringify({ name: 'w', steps: [{ action: 'goto', url: '/' }] }));
      await page.click('#start-run-form button[type="submit"]');
      await page.waitForSelector('#start-result .lv-alert-ok', { timeout: 5000 }).catch(async () => { throw new Error('start-result: ' + (await page.locator('#start-result').innerText()) + ' errors ' + JSON.stringify(session.errors)); });
      expect(await page.locator('#start-result').innerText()).toContain('Run queued');
      expect(mock.createBody.suiteName).toBe('smoke-suite');
      expect(mock.createBody.workflow.name).toBe('w');
      await page.waitForFunction(() => document.getElementById('usage-count').textContent === '13 / 100');
      await page.waitForSelector('tr[data-run-id="run_new00000001"]');
    });
  });

  it('shows the quota message on 429 and zod issues on INVALID_REQUEST', async () => {
    const mock = createMock({ runs: [], createStatus: 429 });
    await withConsole(mock, '#runs/new', undefined, async (page) => {
      await page.waitForSelector('#start-run-form', { state: 'visible' });
      await page.fill('#start-suite', 'x');
      await page.fill('#start-target', 'https://staging.example.com');
      await page.click('#start-run-form button[type="submit"]');
      await page.waitForSelector('#start-result [role="alert"]');
      expect(await page.locator('#start-result').innerText()).toMatch(/100 of 100 runs used today\. Resets at .+\./);

      mock.createStatus = 400;
      await page.click('#start-run-form button[type="submit"]');
      await page.waitForFunction(() => document.querySelector('#start-result li'));
      expect(await page.locator('#start-result li').innerText()).toBe('targetUrl: Invalid url');
    });
  });

  it('renders run detail from the API and cancels an active run', async () => {
    const queued = makeRun({ id: 'run_det00000001', status: 'QUEUED', suiteName: 'detail-suite', queuePosition: 3, startedAt: null, finishedAt: null, executionTimeMs: null, totalSteps: 0, passedSteps: 0, hasEvidence: false });
    const failed = makeRun({ id: 'run_det00000002', status: 'FAILED', suiteName: 'broken-suite', failedSteps: 1, passedSteps: 1, failureReason: 'STEP_FAILED' });
    const mock = createMock({ runs: [queued, failed] });
    await withConsole(mock, '#run-detail/run_det00000002', undefined, async (page) => {
      await page.waitForSelector('#run-detail-title');
      const text = await page.locator('#live-run-detail').innerText();
      expect(text).toContain('broken-suite');
      expect(text).toContain('Timeout waiting for #cart');
      expect(text).toContain('A step failed');
      expect(text).toContain('api.stripe.com');
      expect(text).toContain('BLOCKED');
      expect(text).toContain('Ed25519');
      expect(await page.locator('#download-evidence').count()).toBe(1);
      expect(await page.locator('#cancel-run').count()).toBe(0);

      await page.goto(origin + '/console#run-detail/run_det00000001');
      await page.waitForSelector('#cancel-run');
      expect(await page.locator('#live-run-detail').innerText()).toContain('Position 3');
      await page.click('#cancel-run');
      expect(await page.locator('dialog').innerText()).toContain('usually refunded');
      await page.click('dialog button:has-text("Cancel run")');
      await page.waitForFunction(() => document.getElementById('run-detail-status').textContent.includes('Cancelled'));
      expect(mock.calls).toContain('POST /v1/runs/run_det00000001/cancel');
    });
  });

  it('renders hostile API values as text and executes nothing', async () => {
    const hostile = makeRun({ id: 'run_xss00000001', suiteName: XSS, targetUrl: 'https://staging.example.com/' + XSS, status: 'FAILED', failureReason: 'STEP_FAILED' });
    const mock = createMock({ runs: [hostile] });
    mock.details.set(hostile.id, makeDetail(hostile, {
      steps: [{ index: 0, action: 'click', target: XSS, ok: false, error: XSS }],
      requests: [{ timestamp: iso(0), method: 'GET', host: 'evil.example', path: '/' + XSS, verdict: 'BLOCKED', reason: XSS }],
      error: XSS,
      createdBy: { type: 'key', label: XSS },
    }));
    mock.keys = [{ id: 'key_x', name: XSS, prefix: 'air_live_zz', createdAt: iso(0), lastUsedAt: null, revokedAt: null }];
    await withConsole(mock, '#runs', undefined, async (page, session) => {
      await page.waitForSelector('tr[data-run-id="run_xss00000001"]');
      expect(await page.locator('tr[data-run-id="run_xss00000001"] a').innerText()).toBe(XSS);
      await page.goto(origin + '/console#run-detail/run_xss00000001');
      await page.waitForSelector('#run-detail-title');
      expect(await page.locator('#run-detail-title').innerText()).toBe(XSS);
      expect(await page.locator('.lv-step-error').innerText()).toBe(XSS);
      await page.goto(origin + '/console#cicd');
      await page.waitForSelector('#keys-table');
      expect(await page.locator('#keys-table td').first().innerText()).toBe(XSS);
      await page.goto(origin + '/console#evidence');
      await page.waitForSelector('.lv-evidence-item');
      await page.waitForTimeout(300);
      expect(await page.evaluate(() => window.__xss)).toBeUndefined();
      expect(await page.locator('img[src="x"]').count()).toBe(0);
      expect(session.errors).toEqual([]);
    });
  });
});

describe('Keys, evidence, settings', () => {
  it('shows a new key token once and revokes keys after confirmation', async () => {
    const mock = createMock({ runs: [] });
    await withConsole(mock, '#cicd', undefined, async (page) => {
      await page.waitForSelector('#create-key-form');
      await page.fill('#key-name', 'ci-main');
      await page.click('#create-key-form button[type="submit"]');
      await page.waitForSelector('#new-key-panel');
      expect(await page.locator('#new-key-token').innerText()).toBe('air_live_SECRETTOKEN0123456789');
      expect(await page.locator('#new-key-panel').innerText()).toContain('You will not see it again');
      await page.waitForSelector('#keys-table');
      expect(await page.locator('#keys-table').innerText()).toContain('ci-main');
      expect(await page.locator('#keys-table').innerText()).not.toContain('SECRETTOKEN');

      await page.click('#dismiss-token');
      expect(await page.locator('#new-key-panel').count()).toBe(0);
      expect(await page.locator('body').innerText()).not.toContain('SECRETTOKEN');

      await page.click('button[data-revoke]');
      await page.waitForSelector('dialog[open]');
      await page.click('dialog button:has-text("Revoke key")');
      await page.waitForSelector('#keys-empty');
      expect(mock.calls).toContain('DELETE /v1/keys/key_1');
    });
  });

  it('shows the CI snippets and API base on CI/CD & API', async () => {
    const mock = createMock({ runs: [] });
    await withConsole(mock, '#cicd', undefined, async (page) => {
      await page.waitForSelector('#create-key-form');
      const text = await page.locator('#live-integrations').innerText();
      expect(text).toContain('AIRLOCK_API_KEY');
      expect(text).toContain('npx airlock test --cloud');
      expect(text).toContain('https://api.qbrin.cloud/v1/runs');
      expect(text).toContain('12 / 100');
    });
  });

  it('verifies evidence with the server and shows the true result, including invalid', async () => {
    const good = makeRun({ id: 'run_ev000000001', suiteName: 'good-suite' });
    const bad = makeRun({ id: 'run_ev000000002', suiteName: 'bad-suite' });
    const none = makeRun({ id: 'run_ev000000003', suiteName: 'no-evidence-suite', hasEvidence: false });
    const mock = createMock({ runs: [good, bad, none] });
    mock.verifyResults = {
      run_ev000000001: { valid: true, warnings: ['Signed with a rotated key'] },
      run_ev000000002: { valid: false, reason: 'Merkle root mismatch', warnings: [] },
    };
    await withConsole(mock, '#evidence', undefined, async (page) => {
      await page.waitForSelector('#evidence-key-id');
      expect(await page.locator('#evidence-key-id').innerText()).toBe('key_test_01');
      expect(await page.locator('#evidence-public-key').innerText()).toContain('BEGIN PUBLIC KEY');
      expect(await page.locator('#live-audit').innerText()).toContain('AIRLOCK_TRUSTED_PUBLIC_KEY=... airlock audit <bundle.json>');
      expect(await page.locator('.lv-evidence-item').count()).toBe(2);
      expect(await page.locator('#live-audit').innerText()).not.toContain('no-evidence-suite');

      await page.click('button[data-verify="run_ev000000001"]');
      await page.waitForSelector('[data-verify-result="valid"]');
      const validText = await page.locator('[data-verify-result="valid"]').innerText();
      expect(validText).toContain('Valid');
      expect(validText).toContain('Signed with a rotated key');

      await page.click('button[data-verify="run_ev000000002"]');
      await page.waitForSelector('[data-verify-result="invalid"]');
      const invalidText = await page.locator('[data-verify-result="invalid"]').innerText();
      expect(invalidText).toContain('Invalid');
      expect(invalidText).toContain('Merkle root mismatch');
      expect(mock.calls.filter((call) => call === 'POST /v1/evidence/verify').length).toBe(2);
    });
  });

  it('renames the workspace and signs out through the API', async () => {
    const mock = createMock({ runs: [] });
    await withConsole(mock, '#settings', undefined, async (page) => {
      await page.waitForSelector('#rename-form');
      expect(await page.locator('#settings-email').innerText()).toBe('maya@example.com');
      await page.fill('#workspace-name', 'Renamed QA');
      await page.click('#rename-form button[type="submit"]');
      await page.waitForFunction(() => document.getElementById('ws-name').textContent === 'Renamed QA');
      const text = await page.locator('#live-settings').innerText();
      for (const removed of ['Members', 'Invite', 'Rotate', 'billing', 'SSO', 'GitHub', 'pull request']) {
        expect(text.toLowerCase()).not.toContain(removed.toLowerCase());
      }
      await page.click('#settings-signout');
      await page.waitForURL(/\/login/);
      expect(mock.calls).toContain('POST /v1/auth/logout');
    });
  });

  it('replaces local-CLI features with an honest preview panel in live mode', async () => {
    const mock = createMock({ runs: [] });
    await withConsole(mock, '#chaos', undefined, async (page) => {
      await page.waitForSelector('#live-chaos .lv-badge-preview');
      const text = await page.locator('#live-chaos').innerText();
      expect(text.toLowerCase()).toContain('preview');
      expect(text).toContain('airlock chaos');
      expect(text).not.toContain('cap_7f2a91');
    });
  });

  it('shows analytics from the API and reloads on a day-range change', async () => {
    const mock = createMock({ runs: [] });
    await withConsole(mock, '#analytics', undefined, async (page) => {
      await page.waitForSelector('#analytics-content .lv-kpi');
      const text = await page.locator('#analytics-content').innerText();
      expect(text).toContain('75%');
      expect(text).toContain('31');
      expect(text).toContain('6');
      await page.click('button[data-days="7"]');
      await page.waitForFunction(() => document.querySelectorAll('#analytics-content .lv-bar-col').length === 7);
    });
  });
});

describe('Review fixes', () => {
  it('does not treat a non-401 /auth/me error as signed out', async () => {
    const mock = createMock();
    mock.handlers['GET /v1/auth/me'] = (route, { json }) => json(429, { code: 'RATE_LIMITED', message: 'Slow down' });
    await withConsole(mock, '', undefined, async (page) => {
      await page.waitForSelector('.boot-error');
      expect(await page.locator('.boot-error').innerText()).toContain('not reachable');
      expect(page.url()).not.toContain('/login');
    });
  });

  it('keeps the user signed in and shows an error when logout fails', async () => {
    const mock = createMock({ runs: [] });
    mock.handlers['POST /v1/auth/logout'] = (route, { json }) => json(500, { code: 'INTERNAL', message: 'Logout broke' });
    await withConsole(mock, '#settings', undefined, async (page) => {
      await page.waitForSelector('#settings-signout');
      await page.click('#settings-signout');
      await page.waitForSelector('#app-toast.is-visible');
      expect(await page.locator('#app-toast').innerText()).toContain('Logout broke');
      expect(page.url()).toContain('/console');
    });
  });

  it('shows a neutral note for a cancelled run and a pending state when cancel only flags a running run', async () => {
    const cancelled = makeRun({ id: 'run_can00000001', status: 'CANCELLED', suiteName: 'cancelled-suite', failureReason: 'CANCELLED', hasEvidence: false });
    const running = makeRun({ id: 'run_can00000002', status: 'RUNNING', suiteName: 'running-suite', finishedAt: null, hasEvidence: false });
    const mock = createMock({ runs: [cancelled, running] });
    mock.handlers['POST /v1/runs/run_can00000002/cancel'] = (route, { json }) => json(200, makeDetail(running));
    await withConsole(mock, '#run-detail/run_can00000001', undefined, async (page) => {
      await page.waitForSelector('#run-cancelled');
      expect(await page.locator('#run-cancelled').innerText()).toContain('This run was cancelled');
      expect(await page.locator('.lv-alert-error').count()).toBe(0);
      await page.goto(origin + '/console#run-detail/run_can00000002');
      await page.waitForSelector('#cancel-run');
      await page.click('#cancel-run');
      await page.click('dialog button:has-text("Cancel run")');
      await page.waitForFunction(() => document.getElementById('cancel-run') && document.getElementById('cancel-run').disabled);
      expect(await page.locator('#cancel-run').innerText()).toBe('Cancelling...');
      await page.waitForFunction(() => document.getElementById('live-announcer').textContent.includes('Cancellation requested'));
    });
  });

  it('keeps runs loaded with Load more when a poll refreshes the first page', async () => {
    const first = [makeRun({ id: 'run_pg00000001', status: 'RUNNING', suiteName: 'page-one', finishedAt: null })];
    const older = makeRun({ id: 'run_pg00000002', suiteName: 'older-page' });
    const mock = createMock({ runs: first });
    mock.handlers['GET /v1/runs'] = (route, { json, url }) => {
      if (url.searchParams.get('cursor')) return json(200, { runs: [older], nextCursor: 'c2' });
      return json(200, { runs: first, nextCursor: 'c1' });
    };
    await withConsole(mock, '#runs', undefined, async (page) => {
      await page.waitForSelector('tr[data-run-id="run_pg00000001"]');
      await page.click('button:has-text("Load more runs")');
      await page.waitForSelector('tr[data-run-id="run_pg00000002"]');
      const before = mock.calls.filter((call) => call === 'GET /v1/runs').length;
      await page.waitForFunction((count) => true, before);
      await page.waitForTimeout(3600);
      expect(mock.calls.filter((call) => call === 'GET /v1/runs').length).toBeGreaterThan(before);
      expect(await page.locator('tr[data-run-id="run_pg00000002"]').count()).toBe(1);
      expect(await page.locator('#run-result-count').innerText()).toContain('2 loaded runs');
      await page.fill('#run-search-full', 'zzz');
      expect(await page.locator('#run-empty-state').innerText()).toContain('No loaded runs match. Load more runs to search further.');
    });
  });
});
