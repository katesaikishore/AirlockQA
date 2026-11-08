import { describe, expect, test } from 'bun:test';
import { buildQaReport, reportDirectory, type QaReportRun } from '../src/qa/report.ts';

const run: QaReportRun = {
  id: 'run_qa_123',
  status: 'FAILED',
  phase: 'TESTS_FAILED',
  repo: 'https://github.com/acme/app',
  sha: 'a'.repeat(40),
  branch: 'main',
  createdAt: '2026-11-08T10:00:00Z',
  finishedAt: '2026-11-08T10:04:00Z',
  gateMode: 'strict',
  suites: [
    { suite: 'smoke', status: 'PASS' },
    { suite: 'explore', status: 'FAIL' },
  ],
  gate: { exitCode: 1, reasons: ['explore: S1 HTTP 500 from GET /api/stats'] },
  findings: [
    { klass: 'http_5xx', severity: 'S1', origin: 'first_party_observed', route: '/dashboard', assertion: 'HTTP 500 from GET /api/stats' },
    { klass: 'failing_test', severity: 'S3', origin: 'sandbox_self_reported', route: 'tests/checkout.spec.ts', assertion: 'checkout | pay fails' },
  ],
  artifacts: [
    { name: 'screenshot-1.jpg', contentType: 'image/jpeg', size: 1234, route: '/dashboard', note: 'HTTP 500' },
  ],
  error: null,
};

describe('QA report markdown', () => {
  test('shows the result, suites, findings with sources, and the screenshot', () => {
    const md = buildQaReport(run, { sealVerified: true, runUrl: 'https://qbrin.cloud/console#qa/run_qa_123' });
    expect(md).toContain('# Airlock QA report: acme/app@aaaaaaa');
    expect(md).toContain('**Result:** FAILED (TESTS_FAILED) · **gate:** failed');
    expect(md).toContain('| smoke | PASS |');
    expect(md).toContain('| explore | FAIL |');
    expect(md).toContain('| S1 | HTTP 500 from GET /api/stats');
    expect(md).toContain('Airlock checker');
    expect(md).toContain('Your tests (self-reported)');
    expect(md).toContain('## Screenshots');
    expect(md).toContain('![/dashboard](screenshots/screenshot-1.jpg)');
    expect(md).toContain('The sealed result was verified');
    expect(md).toContain('https://qbrin.cloud/console#qa/run_qa_123');
  });

  test('escapes pipes and newlines so a finding cannot break the table', () => {
    const bad: QaReportRun = {
      ...run,
      findings: [{ klass: 'console_error', severity: 'S3', origin: 'first_party_observed', route: '/a|b', assertion: 'line one\nline two | three' }],
      artifacts: [],
    };
    const md = buildQaReport(bad);
    expect(md).toContain('/a\\|b');
    expect(md).toContain('line one line two \\| three');
    expect(md).not.toContain('line one\nline two');
  });

  test('an empty run says so instead of inventing findings', () => {
    const empty: QaReportRun = { ...run, findings: [], artifacts: [], gate: null, status: 'SUCCESS', phase: 'DONE', suites: [] };
    const md = buildQaReport(empty);
    expect(md).toContain('No findings were stored for this run.');
    expect(md).toContain('No suite result was stored.');
    expect(md).not.toContain('## Screenshots');
  });

  test('report directory rejects a traversal run id', () => {
    expect(reportDirectory('run_qa_123')).toBe('qa-reports/run_qa_123');
    expect(() => reportDirectory('../escape')).toThrow();
  });
});
