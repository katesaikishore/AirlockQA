/**
 * `airlock flake` engine tests: synthetic reporter manifests only (no browser, no temp files).
 */
import { describe, expect, test } from 'bun:test';
import { analyzeFlakiness, renderFlakeMarkdown } from '../src/flake/index.js';
import type { AirlockReportTest, AirlockRunReport } from '../src/testing/airlock-report.js';
import { classifyErrorText, redactEvidenceText } from '../src/flake/index.js';

let runSequence = 0;

function makeTest(overrides: Partial<AirlockReportTest> = {}): AirlockReportTest {
  const title = overrides.title ?? 'test';
  const file = overrides.file ?? 'tests/app.spec.ts';
  const project = overrides.project ?? 'chromium';
  return {
    id: `${project}::${file}::${title}`,
    title,
    titlePath: [title],
    file,
    project,
    status: 'passed',
    retries: 0,
    durationMs: 100,
    errors: [],
    ...overrides,
  };
}

function makeReport(tests: AirlockReportTest[], overrides: Partial<AirlockRunReport> = {}): AirlockRunReport {
  runSequence += 1;
  return {
    version: 1,
    tool: 'airlock-reporter',
    runId: `run-${String(runSequence).padStart(3, '0')}`,
    startedAt: `2026-11-0${(runSequence % 9) + 1}T10:00:00.000Z`,
    finishedAt: `2026-11-0${(runSequence % 9) + 1}T10:01:00.000Z`,
    durationMs: 60_000,
    tests,
    ...overrides,
  };
}

/** One test entry for a report: helper for "pass in run N" fixtures. */
const pass = (overrides: Partial<AirlockReportTest> = {}) => makeTest({ status: 'passed', ...overrides });
const fail = (errors: string[], overrides: Partial<AirlockReportTest> = {}) =>
  makeTest({ status: 'failed', errors, ...overrides });

const NETWORK_ERROR = 'page.goto: net::ERR_CONNECTION_RESET at https://staging.example.com/checkout';
const SELECTOR_ERROR = 'locator.click: Timeout 30000ms exceeded. waiting for selector "#cart"';
const TIMEOUT_ERROR = 'Test timeout of 30000ms exceeded.';
const APP_RACE_ERROR = 'expect(received).toBe(expected) // Object.is equality: expected status 200, received 500';
const POLICY_ERROR = 'Request blocked by the request policy: POST https://api.example.com/refunds denied by rule block-refunds';
const MYSTERY_ERROR = 'mystery condition occurred while running the journey (code 123)';

function findByTitle(analysis: ReturnType<typeof analyzeFlakiness>, title: string) {
  const found = analysis.tests.find((test) => test.title === title);
  if (!found) throw new Error(`test not found: ${title}`);
  return found;
}

describe('mixed flaky tests in one manifest set', () => {
  const reports = [
    makeReport([
      fail([NETWORK_ERROR], { title: 'checkout retries the payment call' }),
      fail([SELECTOR_ERROR], { title: 'cart badge updates' }),
      fail([TIMEOUT_ERROR], { title: 'search results render' }),
      fail([APP_RACE_ERROR], { title: 'totals stay correct' }),
      fail([POLICY_ERROR], { title: 'refunds are stopped' }),
      fail([MYSTERY_ERROR], { title: 'onboarding completes' }),
      pass({ title: 'home page loads' }),
    ]),
    makeReport([
      pass({ title: 'checkout retries the payment call' }),
      pass({ title: 'cart badge updates', retries: 1 }),
      pass({ title: 'search results render', retries: 2 }),
      fail([APP_RACE_ERROR], { title: 'totals stay correct' }),
      pass({ title: 'refunds are stopped' }),
      pass({ title: 'onboarding completes' }),
      pass({ title: 'home page loads' }),
    ]),
    makeReport([
      pass({ title: 'checkout retries the payment call' }),
      pass({ title: 'cart badge updates' }),
      fail([TIMEOUT_ERROR], { title: 'search results render' }),
      fail([APP_RACE_ERROR], { title: 'totals stay correct' }),
      pass({ title: 'refunds are stopped' }),
      pass({ title: 'onboarding completes' }),
      pass({ title: 'home page loads' }),
    ]),
  ];
  const analysis = analyzeFlakiness(reports);

  test('counts reports, tests, flaky tests and per-class totals', () => {
    expect(analysis.reports).toBe(3);
    expect(analysis.totalTests).toBe(7);
    expect(analysis.flakyTests).toBe(5);
    expect(analysis.totals).toEqual({
      network_fixture: 1,
      policy_block: 1,
      selector_drift: 1,
      timing: 1,
      app_race: 1,
      unknown: 2,
    });
  });

  test('classifies network, selector and timing failures from recorded text', () => {
    const network = findByTitle(analysis, 'checkout retries the payment call');
    expect(network.classification).toBe('network_fixture');
    expect(network.runs).toBe(3);
    expect(network.passes).toBe(2);
    expect(network.failures).toBe(1);
    expect(network.flakeRate).toBeCloseTo(1 / 3, 5);
    expect(network.confidence).toBe('high');
    expect(network.evidence.length).toBeGreaterThan(0);
    expect(network.evidence.join(' ')).toContain('ERR_CONNECTION_RESET');

    const selector = findByTitle(analysis, 'cart badge updates');
    expect(selector.classification).toBe('selector_drift');
    expect(selector.retries).toBe(1);
    // One failed run plus one run that only passed after a retry.
    expect(selector.failures).toBe(1);
    expect(selector.flakeCount).toBe(2);
    expect(selector.flakeRate).toBeCloseTo(2 / 3, 5);
    expect(selector.confidence).toBe('high');
    expect(selector.evidence.join(' ')).toContain('selector');

    const timing = findByTitle(analysis, 'search results render');
    expect(timing.classification).toBe('timing');
    expect(timing.retries).toBe(2);
    expect(timing.confidence).toBe('high');
    expect(timing.evidence.join(' ')).toContain('timeout');
  });

  test('separates stable failures from flakes but still classifies them', () => {
    const stableFailure = findByTitle(analysis, 'totals stay correct');
    expect(stableFailure.failures).toBe(3);
    expect(stableFailure.passes).toBe(0);
    expect(stableFailure.classification).toBe('app_race');
    expect(stableFailure.quarantined).toBe(false);

    const stablePass = findByTitle(analysis, 'home page loads');
    expect(stablePass.runs).toBe(3);
    expect(stablePass.failures).toBe(0);
    expect(stablePass.flakeCount).toBe(0);
    expect(stablePass.classification).toBe('unknown');
    expect(stablePass.quarantined).toBe(false);
  });

  test('classifies policy-blocked failures and keeps unknown honest', () => {
    const policy = findByTitle(analysis, 'refunds are stopped');
    expect(policy.classification).toBe('policy_block');
    expect(policy.evidence.join(' ')).toContain('policy');
    expect(policy.quarantined).toBe(true);

    const unknown = findByTitle(analysis, 'onboarding completes');
    expect(unknown.classification).toBe('unknown');
    expect(unknown.evidence).toEqual([]);
    expect(unknown.confidence).toBe('low');
    // Flaky with no mappable cause can still be quarantined (rate 0.5 >= 0.2).
    expect(unknown.quarantined).toBe(true);
  });

  test('quarantines flaky tests meeting the default threshold, in a deterministic order', () => {
    expect(analysis.quarantine.map((test) => test.title)).toEqual([
      'search results render',
      'cart badge updates',
      'checkout retries the payment call',
      'onboarding completes',
      'refunds are stopped',
    ]);
    // Ordering: quarantined first, then by flake rate descending, then id.
    const rates = analysis.quarantine.map((test) => test.flakeRate);
    expect([...rates].sort((a, b) => b - a)).toEqual(rates);
  });

  test('renderFlakeMarkdown contains the table, causes, owners and quarantine state', () => {
    const markdown = renderFlakeMarkdown(analysis);
    expect(markdown).toContain('| Test | File | Runs | Flakes | Cause | Owner | Quarantine |');
    expect(markdown).toContain('## Totals');
    expect(markdown).toContain('- network_fixture: 1');
    expect(markdown).toContain('checkout retries the payment call');
    expect(markdown).toContain('network_fixture');
    expect(markdown).toContain('| yes |');
    expect(markdown).toContain('| no |');
    expect(markdown).toContain('## Warnings');
    // Deterministic and timestamp-free.
    expect(renderFlakeMarkdown(analysis)).toBe(markdown);
  });
});

describe('classification priority and confidence', () => {
  test('a mixed-class flake is classified by the deterministic priority and gets medium confidence', () => {
    const analysis = analyzeFlakiness([
      makeReport([fail(['connect ECONNREFUSED 127.0.0.1:5432'], { title: 'db-backed search' })]),
      makeReport([fail([SELECTOR_ERROR], { title: 'db-backed search' })]),
      makeReport([pass({ title: 'db-backed search' })]),
    ]);
    const test = findByTitle(analysis, 'db-backed search');
    expect(test.classification).toBe('network_fixture');
    expect(test.confidence).toBe('medium');
    expect(test.evidence.join(' ')).toContain('ECONNREFUSED');
  });

  test('a two-run flake is medium confidence, a one-run failure is low and not flaky', () => {
    const analysis = analyzeFlakiness([
      makeReport([fail([APP_RACE_ERROR], { title: 'two runs' }), fail([MYSTERY_ERROR], { title: 'one run' })]),
      makeReport([pass({ title: 'two runs' })]),
    ]);
    const two = findByTitle(analysis, 'two runs');
    expect(two.runs).toBe(2);
    expect(two.confidence).toBe('medium');
    const one = findByTitle(analysis, 'one run');
    expect(one.runs).toBe(1);
    expect(one.flakeCount).toBe(1);
    expect(one.passes).toBe(0);
    expect(one.confidence).toBe('low');
    expect(one.quarantined).toBe(false);
  });

  test('a test that only passed after retries is flaky, and the timeout class is timing', () => {
    const analysis = analyzeFlakiness([
      makeReport([pass({ title: 'retry-only', retries: 1, errors: [TIMEOUT_ERROR] })]),
      makeReport([pass({ title: 'retry-only', retries: 2, errors: [TIMEOUT_ERROR] })]),
      makeReport([pass({ title: 'retry-only', retries: 1, errors: [TIMEOUT_ERROR] })]),
    ]);
    const test = findByTitle(analysis, 'retry-only');
    expect(test.passes).toBe(3);
    expect(test.failures).toBe(0);
    expect(test.retries).toBe(4);
    expect(test.flakeCount).toBe(3);
    expect(test.flakeRate).toBe(1);
    expect(test.classification).toBe('timing');
    expect(test.confidence).toBe('high');
    expect(test.quarantined).toBe(true);
    expect(analysis.flakyTests).toBe(1);
  });

  test('the classifier is deterministic across repeated calls and ignores unrelated text', () => {
    expect(classifyErrorText(TIMEOUT_ERROR)?.classification).toBe('timing');
    expect(classifyErrorText(SELECTOR_ERROR)?.classification).toBe('selector_drift');
    expect(classifyErrorText('locator.waitFor: Timeout 5000ms exceeded waiting for selector "#x"')?.classification).toBe('selector_drift');
    expect(classifyErrorText('unrelated log line')).toBeNull();
    expect(classifyErrorText('')).toBeNull();
  });
});

describe('owner mapping and quarantine options', () => {
  test('ownerMap matches by id first, then file', () => {
    const byFile = makeTest({ title: 'file owner', file: 'tests/owned.spec.ts' });
    const byId = makeTest({ title: 'id owner', file: 'tests/owned.spec.ts' });
    const noOwner = makeTest({ title: 'nobody', file: 'tests/other.spec.ts' });
    const analysis = analyzeFlakiness(
      [
        makeReport([fail([NETWORK_ERROR], byFile), fail([NETWORK_ERROR], byId), fail([NETWORK_ERROR], noOwner)]),
        makeReport([
          pass({ title: byFile.title, file: byFile.file }),
          pass({ title: byId.title, file: byId.file, id: byId.id }),
          pass({ title: noOwner.title, file: noOwner.file }),
        ]),
      ],
      {
        ownerMap: {
          'tests/owned.spec.ts': '@file-team',
          [byId.id]: '@id-team',
        },
      }
    );
    expect(findByTitle(analysis, 'file owner').owner).toBe('@file-team');
    expect(findByTitle(analysis, 'id owner').owner).toBe('@id-team');
    expect(findByTitle(analysis, 'nobody').owner).toBeUndefined();
    const markdown = renderFlakeMarkdown(analysis);
    expect(markdown).toContain('@id-team');
    expect(markdown).toContain('@file-team');
  });

  test('a custom flakeThreshold changes the quarantine set (inclusive boundary)', () => {
    const flaky = makeTest({ title: 'half flaky' });
    const reports = [
      makeReport([fail([APP_RACE_ERROR], { title: flaky.title })]),
      makeReport([pass({ title: flaky.title })]),
    ];
    const below = analyzeFlakiness(reports, { flakeThreshold: 0.6 });
    expect(findByTitle(below, 'half flaky').flakeRate).toBe(0.5);
    expect(below.quarantine).toHaveLength(0);
    const inclusive = analyzeFlakiness(reports, { flakeThreshold: 0.5 });
    expect(inclusive.quarantine.map((test) => test.title)).toEqual(['half flaky']);
  });

  test('minRuns keeps a thin sample out of quarantine and warns about it', () => {
    const flaky = makeTest({ title: 'thin sample' });
    const analysis = analyzeFlakiness([makeReport([fail([APP_RACE_ERROR], { title: flaky.title })]), makeReport([pass({ title: flaky.title })])], { minRuns: 3 });
    const test = findByTitle(analysis, 'thin sample');
    expect(test.runs).toBe(2);
    expect(test.flakeRate).toBe(0.5);
    expect(test.quarantined).toBe(false);
    expect(analysis.quarantine).toHaveLength(0);
    expect(analysis.warnings.some((warning) => warning.includes('fewer than minRuns'))).toBe(true);
  });

  test('skipped tests are not runs: they are listed, never flaky and not quarantined', () => {
    const analysis = analyzeFlakiness([
      makeReport([makeTest({ title: 'always skipped', status: 'skipped' }), pass({ title: 'real test' })]),
      makeReport([makeTest({ title: 'always skipped', status: 'skipped' }), pass({ title: 'real test' })]),
    ]);
    const skipped = findByTitle(analysis, 'always skipped');
    expect(skipped.runs).toBe(0);
    expect(skipped.flakeRate).toBe(0);
    expect(skipped.quarantined).toBe(false);
    expect(skipped.classification).toBe('unknown');
    expect(analysis.totalTests).toBe(2);
  });
});

describe('warnings, empty input and validation', () => {
  test('empty report list yields an empty analysis with a warning', () => {
    const analysis = analyzeFlakiness([]);
    expect(analysis.reports).toBe(0);
    expect(analysis.totalTests).toBe(0);
    expect(analysis.flakyTests).toBe(0);
    expect(analysis.tests).toEqual([]);
    expect(analysis.quarantine).toEqual([]);
    expect(analysis.totals).toEqual({ network_fixture: 0, policy_block: 0, selector_drift: 0, timing: 0, app_race: 0, unknown: 0 });
    expect(analysis.warnings).toContain('No reports were provided; nothing to analyze.');
    const markdown = renderFlakeMarkdown(analysis);
    expect(markdown).toContain('_No tests recorded_');
    expect(markdown).toContain('No reports were provided');
  });

  test('reports with no tests and duplicate runIds are reported and not double counted', () => {
    const analysis = analyzeFlakiness([
      makeReport([], { runId: 'run-empty' }),
      makeReport([pass({ title: 'real' })], { runId: 'run-dup' }),
      makeReport([fail([APP_RACE_ERROR], { title: 'ignored' })], { runId: 'run-dup' }),
    ]);
    expect(analysis.reports).toBe(2);
    expect(analysis.totalTests).toBe(1);
    expect(analysis.warnings.some((warning) => warning.includes('"run-empty" has no tests'))).toBe(true);
    expect(analysis.warnings.some((warning) => warning.includes('Duplicate runId "run-dup"'))).toBe(true);
    expect(analysis.tests.map((test) => test.title)).toEqual(['real']);
  });

  test('invalid options are refused instead of silently defaulted', () => {
    expect(() => analyzeFlakiness([], { minRuns: 0 })).toThrow('minRuns must be a positive integer');
    expect(() => analyzeFlakiness([], { minRuns: 1.5 })).toThrow('minRuns must be a positive integer');
    expect(() => analyzeFlakiness([], { flakeThreshold: -0.1 })).toThrow('flakeThreshold must be a number between 0 and 1');
    expect(() => analyzeFlakiness([], { flakeThreshold: 1.1 })).toThrow('flakeThreshold must be a number between 0 and 1');
    expect(() => analyzeFlakiness('nope' as unknown as AirlockRunReport[])).toThrow('reports must be an array');
  });
});

describe('evidence is short, quoted and never carries credentials', () => {
  test('redacts API keys, bearer tokens and passwords but keeps the useful fragment', () => {
    const analysis = analyzeFlakiness([
      makeReport([
        fail(['request failed: Authorization: Bearer sk_live_abcdef1234567890 leaked while calling https://api.example.com'], {
          title: 'secret-bearing retry',
        }),
      ]),
      makeReport([pass({ title: 'secret-bearing retry' })]),
    ]);
    const test = findByTitle(analysis, 'secret-bearing retry');
    expect(test.evidence).toHaveLength(1);
    expect(test.evidence[0].startsWith('"')).toBe(true);
    expect(test.evidence[0].endsWith('"')).toBe(true);
    expect(test.evidence[0]).toContain('[redacted]');
    expect(test.evidence[0]).not.toContain('sk_live_abcdef1234567890');
    expect(redactEvidenceText('password=hunter2 and token: abc123')).not.toContain('hunter2');
    expect(redactEvidenceText('password=hunter2 and token: abc123')).not.toContain('abc123');
    expect(redactEvidenceText('line one\nline two')).toBe('line one line two');
  });

  test('the analysis result is deterministic apart from generatedAt', () => {
    const reports = [
      makeReport([fail([NETWORK_ERROR], { title: 'same flake' })]),
      makeReport([pass({ title: 'same flake' })]),
    ];
    const first = analyzeFlakiness(reports);
    const second = analyzeFlakiness(reports);
    expect(first.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const strip = (analysis: typeof first) => ({ ...analysis, generatedAt: '<time>' });
    expect(strip(first)).toEqual(strip(second));
    expect(renderFlakeMarkdown(first)).toBe(renderFlakeMarkdown(second));
  });
});
