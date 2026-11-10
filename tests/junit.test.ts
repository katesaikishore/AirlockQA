import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadReportIfExists, parseJUnitReport, triageRuns } from '../src/verified-merge/index.js';

function fixture(xml: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qafind-junit-'));
  const file = path.join(dir, 'results.xml');
  fs.writeFileSync(file, xml);
  return file;
}
const failed = `<?xml version="1.0"?><testsuites><testsuite name="checkout"><testcase classname="cypress/e2e/cart.cy.ts" name="adds an item" time="1.2"><failure message="expected 10, got 9">AssertionError: expected 10, got 9</failure></testcase></testsuite></testsuites>`;
const passed = `<?xml version="1.0"?><testsuites><testsuite name="checkout"><testcase classname="cypress/e2e/cart.cy.ts" name="adds an item" time="1.1"/></testsuite></testsuites>`;

describe('JUnit XML ingest', () => {
  test('parses a failure and a rerun pass, and classifies it as a flake', () => {
    const first = parseJUnitReport(fixture(failed));
    const rerun = loadReportIfExists(fixture(passed))!;
    expect(first.tests[0].status).toBe('failed');
    expect(first.tests[0].attempts[0].error).toContain('expected 10, got 9');
    expect(rerun.tests[0].status).toBe('passed');
    expect(triageRuns(first, rerun)[0].status).toBe('flake');
  });

  test('detects XML by content, not only extension', () => {
    const file = fs.mkdtempSync(path.join(os.tmpdir(), 'qafind-junit-ext-')) + '/report.txt';
    fs.writeFileSync(file, failed);
    const report = loadReportIfExists(file)!;
    expect(report.tests).toHaveLength(1);
  });

  test('parses skipped and self-closing cases', () => {
    const report = parseJUnitReport(fixture(`<testsuite><testcase name="one" time="0.1"/><testcase name="two"><skipped message="later"/></testcase></testsuite>`));
    expect(report.tests.map((test) => test.status)).toEqual(['passed', 'skipped']);
  });
});
