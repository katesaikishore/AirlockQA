/**
 * Tests for the attach-path Playwright reporter (`src/testing/airlock-reporter.ts`).
 * Fake Playwright config/test/result objects only: no browser, no test runner.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AirlockReporter,
  airlockTestId,
  createAirlockReporter,
  defaultAirlockRunId,
  normalizeTestFile,
  titlesFromTitlePath,
  toAirlockTestStatus,
} from '../src/testing/airlock-reporter.js';
import { isAirlockRunReport, readRunReports } from '../src/testing/airlock-report.js';
import type { FullResult, TestCase, TestResult } from '@playwright/test/reporter';

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(prefix = 'airlock-reporter-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function clockSequence(times: string[]): () => Date {
  let index = 0;
  return () => new Date(times[Math.min(index++, times.length - 1)]!);
}

function fakeConfig(projectNames: string[], rootDir: string): never {
  return { projects: projectNames.map((name) => ({ name })), rootDir } as never;
}

interface FakeTestInput {
  project: string;
  file: string;
  titles: string[];
  /** Default true: Playwright's titlePath() starts with the project name. */
  projectInTitlePath?: boolean;
}

function fakeTest(input: FakeTestInput): TestCase {
  const projectInTitlePath = input.projectInTitlePath !== false;
  const chain = projectInTitlePath ? [input.project, ...input.titles] : [...input.titles];
  return {
    title: input.titles[input.titles.length - 1],
    location: { file: input.file, line: 1, column: 1 },
    titlePath: () => chain,
    parent: { project: () => ({ name: input.project }) },
  } as unknown as TestCase;
}

interface FakeResultInput {
  status?: string;
  retry?: number;
  duration?: number;
  errors?: Array<{ message?: string }>;
  attachments?: Array<{ name?: string; path?: string; contentType?: string; body?: Buffer }>;
}

function fakeResult(input: FakeResultInput = {}): TestResult {
  return {
    status: input.status ?? 'passed',
    retry: input.retry ?? 0,
    duration: input.duration ?? 10,
    errors: input.errors ?? [],
    attachments: input.attachments ?? [],
  } as unknown as TestResult;
}

describe('airlock reporter', () => {
  it('writes a manifest with passed/failed/flaky/skipped/timedOut/interrupted tests', () => {
    const outputDir = tmpDir();
    const reporter = new AirlockReporter({
      outputDir,
      runId: 'run-attach-test-1',
      now: clockSequence(['2026-01-01T00:00:00.000Z', '2026-01-01T00:00:05.000Z']),
    });

    reporter.onBegin(fakeConfig(['chromium', 'firefox'], '/repo'), {} as never);

    // passed first time
    reporter.onTestEnd(
      fakeTest({ project: 'chromium', file: '/repo/tests/checkout.spec.ts', titles: ['checkout', 'adds a plan to the cart'] }),
      fakeResult({ status: 'passed', retry: 0, duration: 120 }),
    );

    // failed with error text + attachment metadata (the body must never be stored)
    reporter.onTestEnd(
      fakeTest({ project: 'firefox', file: '/repo/tests/auth.spec.ts', titles: ['auth', 'rejects a bad password'] }),
      fakeResult({
        status: 'failed',
        duration: 80,
        errors: [{ message: 'Expected 200, but got 401' }],
        attachments: [
          { name: 'trace', path: '/repo/test-results/trace.zip', contentType: 'application/zip', body: Buffer.from('attachment-body-must-not-be-stored') },
        ],
      }),
    );

    // flaky: failed attempt 1, passed attempt 2 — the manifest keeps only the final outcome.
    const flaky = fakeTest({ project: 'chromium', file: '/repo/tests/flaky.spec.ts', titles: ['flaky', 'eventually passes'] });
    reporter.onTestEnd(flaky, fakeResult({ status: 'failed', retry: 0, duration: 50, errors: [{ message: 'first attempt failed' }] }));
    reporter.onTestEnd(flaky, fakeResult({ status: 'passed', retry: 1, duration: 200 }));

    reporter.onTestEnd(
      fakeTest({ project: 'firefox', file: '/repo/tests/skip.spec.ts', titles: ['skip', 'is skipped'] }),
      fakeResult({ status: 'skipped', duration: 0 }),
    );
    reporter.onTestEnd(
      fakeTest({ project: 'chromium', file: '/repo/tests/slow.spec.ts', titles: ['slow', 'times out'] }),
      fakeResult({ status: 'timedOut', duration: 30_000, errors: [{ message: 'Timeout 30000ms exceeded.' }] }),
    );
    reporter.onTestEnd(
      fakeTest({ project: 'firefox', file: '/repo/tests/interrupt.spec.ts', titles: ['interrupt', 'is interrupted'] }),
      fakeResult({ status: 'interrupted', duration: 5 }),
    );

    reporter.onEnd({ status: 'failed', startTime: new Date('2026-01-01T00:00:00.000Z'), duration: 5_555 } as unknown as FullResult);

    const files = fs.readdirSync(outputDir);
    expect(files).toEqual(['run-attach-test-1.json']);
    const reports = readRunReports(outputDir);
    expect(reports).toHaveLength(1);
    const report = reports[0]!;
    expect(isAirlockRunReport(report)).toBe(true);
    expect(report).toMatchObject({
      version: 1,
      tool: 'airlock-reporter',
      runId: 'run-attach-test-1',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:05.000Z',
      durationMs: 5_555,
      projects: ['chromium', 'firefox'],
    });
    expect(report.tests).toHaveLength(6);

    const checkout = report.tests.find((test) => test.id.includes('checkout.spec.ts'))!;
    expect(checkout).toMatchObject({
      id: 'chromium::tests/checkout.spec.ts::checkout › adds a plan to the cart',
      title: 'adds a plan to the cart',
      titlePath: ['checkout', 'adds a plan to the cart'],
      file: 'tests/checkout.spec.ts',
      project: 'chromium',
      status: 'passed',
      retries: 0,
      durationMs: 120,
      errors: [],
    });

    const failed = report.tests.find((test) => test.id.includes('auth.spec.ts'))!;
    expect(failed.status).toBe('failed');
    expect(failed.errors[0]).toContain('Expected 200, but got 401');
    expect(failed.attachments).toEqual([{ name: 'trace', path: '/repo/test-results/trace.zip', contentType: 'application/zip' }]);
    expect(JSON.stringify(failed)).not.toContain('attachment-body-must-not-be-stored');

    const flakyEntry = report.tests.find((test) => test.id.includes('flaky.spec.ts'))!;
    expect(flakyEntry.status).toBe('passed');
    expect(flakyEntry.retries).toBe(1);
    expect(flakyEntry.errors).toEqual([]);
    expect(report.tests.filter((test) => test.id.includes('flaky.spec.ts'))).toHaveLength(1);

    expect(report.tests.find((test) => test.id.includes('skip.spec.ts'))!.status).toBe('skipped');
    expect(report.tests.find((test) => test.id.includes('slow.spec.ts'))!.status).toBe('timedOut');
    expect(report.tests.find((test) => test.id.includes('interrupt.spec.ts'))!.status).toBe('interrupted');

    // The manifest itself contains no attachment body text and no stack traces.
    const raw = fs.readFileSync(path.join(outputDir, 'run-attach-test-1.json'), 'utf8');
    expect(raw).not.toContain('attachment-body-must-not-be-stored');
  });

  it('generates a sortable default run id when none is injected', () => {
    const outputDir = tmpDir();
    const reporter = new AirlockReporter({ outputDir, now: clockSequence(['2026-02-03T04:05:06.000Z']) });
    reporter.onBegin(fakeConfig(['chromium'], '/repo'), {} as never);
    reporter.onEnd({ status: 'passed', startTime: new Date(), duration: 1 } as unknown as FullResult);

    const reports = readRunReports(outputDir);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.runId).toMatch(/^run-\d{8}T\d{6}Z-[0-9a-f]{6}$/);
    expect(defaultAirlockRunId(new Date('2026-02-03T04:05:06.000Z'))).toMatch(/^run-20260203T040506Z-[0-9a-f]{6}$/);
  });

  it('does not throw when the manifest cannot be written, and warns once', () => {
    const root = tmpDir();
    const blocker = path.join(root, 'not-a-directory');
    fs.writeFileSync(blocker, 'x');
    const outputDir = path.join(blocker, 'reports');
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      const reporter = createAirlockReporter({ outputDir, runId: 'run-unwritable' });
      expect(reporter).toBeInstanceOf(AirlockReporter);
      expect(() => {
        reporter.onBegin(fakeConfig(['chromium'], '/repo'), {} as never);
        reporter.onTestEnd(fakeTest({ project: 'chromium', file: '/repo/a.spec.ts', titles: ['a'] }), fakeResult());
        reporter.onEnd({ status: 'passed', startTime: new Date(), duration: 1 } as unknown as FullResult);
        reporter.onEnd({ status: 'passed', startTime: new Date(), duration: 1 } as unknown as FullResult);
      }).not.toThrow();
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('[airlock-reporter]');
    expect(warnings[0]).toContain('onEnd failed');
  });

  it('does not replace the default reporters (printsToStdio false)', () => {
    const reporter = new AirlockReporter();
    expect(reporter.printsToStdio()).toBe(false);
  });

  it('maps statuses and normalises ids/paths/title paths', () => {
    expect(toAirlockTestStatus('passed')).toBe('passed');
    expect(toAirlockTestStatus('timedOut')).toBe('timedOut');
    expect(toAirlockTestStatus('interrupted')).toBe('interrupted');
    expect(toAirlockTestStatus('something-else')).toBe('failed');

    expect(normalizeTestFile('/repo/tests/payment.spec.ts', '/repo')).toBe('tests/payment.spec.ts');
    expect(normalizeTestFile('/elsewhere/payment.spec.ts', '/repo')).toBe('/elsewhere/payment.spec.ts');
    expect(normalizeTestFile('', '/repo')).toBe('');

    expect(titlesFromTitlePath(['chromium', 'checkout', 'pays'], 'chromium')).toEqual(['checkout', 'pays']);
    expect(titlesFromTitlePath(['checkout', 'pays'], 'chromium')).toEqual(['checkout', 'pays']);
    expect(titlesFromTitlePath(['chromium'], 'chromium')).toEqual(['chromium']);

    expect(airlockTestId('chromium', 'tests/a.spec.ts', ['describe', 'test'])).toBe(
      'chromium::tests/a.spec.ts::describe › test',
    );
  });

  it('handles a test whose titlePath() does not start with the project', () => {
    const outputDir = tmpDir();
    const reporter = new AirlockReporter({
      outputDir,
      runId: 'run-no-project-prefix',
      now: clockSequence(['2026-01-01T00:00:00.000Z']),
    });
    reporter.onBegin(fakeConfig(['chromium'], '/repo'), {} as never);
    reporter.onTestEnd(
      fakeTest({ project: 'chromium', file: '/repo/tests/a.spec.ts', titles: ['outer', 'inner'], projectInTitlePath: false }),
      fakeResult({ status: 'passed' }),
    );
    reporter.onEnd({ status: 'passed', startTime: new Date(), duration: 7 } as unknown as FullResult);
    const [report] = readRunReports(outputDir);
    expect(report!.tests[0]!.titlePath).toEqual(['outer', 'inner']);
    expect(report!.tests[0]!.project).toBe('chromium');
  });
});
