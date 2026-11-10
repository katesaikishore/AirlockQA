import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildInTotoStatement, buildVerdict, parsePlaywrightReport, renderVerdictMarkdown, signVerdict, triageRuns, verifySignedVerdict } from '../src/verified-merge/index.js';
import { failedSpecFiles, runPlaywright } from '../src/verified-merge/run.js';
import { canonicalJson, verifyHmac } from '../src/utils/crypto.js';

function reportFile(passing: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airlock-vm-'));
  const file = path.join(dir, 'results.json');
  const report = {
    stats: { expected: 0, unexpected: passing ? 0 : 1, flaky: 0, skipped: 0, duration: 12 },
    suites: [{ title: 'cart.spec.ts', file: 'cart.spec.ts', specs: [{ title: 'cart total', file: 'cart.spec.ts', ok: passing, tests: [{ status: passing ? 'expected' : 'unexpected', projectName: 'chromium', results: [{ status: passing ? 'passed' : 'failed', duration: 12, error: passing ? undefined : { message: 'expected 10 received 9' } }] }] }], suites: [] }],
  };
  fs.writeFileSync(file, JSON.stringify(report));
  return file;
}

describe('Verified Merge triage', () => {
  test('a failure that fails again is a reproduced regression', () => {
    const first = parsePlaywrightReport(reportFile(false));
    const rerun = parsePlaywrightReport(reportFile(false));
    const verdicts = triageRuns(first, rerun);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].status).toBe('regression');
    expect(verdicts[0].reproduction).toBe('all-failed');
  });

  test('a failure that passes on rerun is a flake, not a regression', () => {
    const first = parsePlaywrightReport(reportFile(false));
    const rerun = parsePlaywrightReport(reportFile(true));
    const verdicts = triageRuns(first, rerun);
    expect(verdicts[0].status).toBe('flake');
    expect(verdicts[0].reproduction).toBe('passed-on-rerun');
  });

  test('without a rerun the failure is not reported as a regression', () => {
    const first = parsePlaywrightReport(reportFile(false));
    const verdict = buildVerdict({ specs: ['cart.spec.ts'], selection: 'changed-tests', first, rerun: null });
    expect(verdict.summary.regressions).toBe(0);
    expect(verdict.summary.notRerun).toBe(1);
    expect(verdict.blockMerge).toBe(false);
    expect(renderVerdictMarkdown(verdict)).toContain('not rerun');
    const intoto = buildInTotoStatement(verdict) as any;
    expect(intoto._type).toBe('https://in-toto.io/Statement/v1');
    expect(intoto.predicate.result).toBe('PASSED');
  });

  test('signs the canonical verdict and includes an in-toto subject', () => {
    const first = parsePlaywrightReport(reportFile(false));
    const verdict = buildVerdict({ repo: 'owner/repo', headSha: 'a'.repeat(40), specs: ['cart.spec.ts'], selection: 'changed-tests', first, rerun: parsePlaywrightReport(reportFile(false)) });
    const signed = signVerdict(verdict, { signingKey: 'test-signing-key-at-least-32-chars-long' });
    expect(signed.signature.algorithm).toBe('HMAC-SHA256');
    expect(verifyHmac(canonicalJson(verdict), signed.signature.signature, 'test-signing-key-at-least-32-chars-long')).toBe(true);
    expect(verdict.blockMerge).toBe(true);
    expect(buildInTotoStatement(verdict).subject).toEqual([{ name: 'owner/repo', digest: { sha1: 'a'.repeat(40) } }]);
    expect(verifySignedVerdict(signed, { signingKey: 'test-signing-key-at-least-32-chars-long' }).valid).toBe(true);
    expect(verifySignedVerdict(signed, { signingKey: 'wrong-signing-key-at-least-32-chars' }).valid).toBe(false);
    const tampered = JSON.parse(JSON.stringify(signed));
    tampered.payload.summary.regressions = 0;
    expect(verifySignedVerdict(tampered, { signingKey: 'test-signing-key-at-least-32-chars-long' }).valid).toBe(false);
  });
});


describe('Verified Merge Playwright runner', () => {
  test('executes the operator command and reads the JSON report from PLAYWRIGHT_JSON_OUTPUT_NAME', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'airlock-vm-cwd-'));
    fs.writeFileSync(path.join(cwd, 'fake.js'), `
      const fs = require('node:fs');
      const out = process.env.PLAYWRIGHT_JSON_OUTPUT_NAME;
      fs.writeFileSync(out, JSON.stringify({ stats: { expected: 0, unexpected: 1, duration: 5 }, suites: [{ title: 'a.spec.ts', file: 'a.spec.ts', specs: [{ title: 'fails', file: 'a.spec.ts', tests: [{ status: 'unexpected', results: [{ status: 'failed', error: { message: 'boom' } }] }] }] }] }));
      process.exit(1);
    `);
    const run = await runPlaywright({ cwd, specs: ['a.spec.ts'], command: 'node fake.js {specs}', timeoutMs: 20_000 });
    expect(run.exitCode).toBe(1);
    expect(fs.existsSync(run.reportPath)).toBe(true);
    const report = parsePlaywrightReport(run.reportPath);
    expect(report.tests[0].status).toBe('failed');
    expect(failedSpecFiles(report)).toEqual(['a.spec.ts']);
  });

  test('refuses to run with no affected specs', async () => {
    await expect(runPlaywright({ cwd: process.cwd(), specs: [] })).rejects.toThrow('no affected specs');
  });
});
