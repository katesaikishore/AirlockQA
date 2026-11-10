/**
 * JUnit XML result ingest for Verified Merge.
 *
 * Cypress, Selenium, WebdriverIO and most CI runners can export JUnit XML. Normalizing it to the same
 * PlaywrightRun shape lets the triage/signing path treat every framework identically: only a failure
 * that reproduces in the rerun report is a regression.
 */
import * as fs from 'node:fs';
import type { MergeTestStatus, PlaywrightRun } from './index.js';

interface Attrs { [key: string]: string }

function decode(value: string): string {
  return value
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function attrs(fragment: string): Attrs {
  const result: Attrs = {};
  const pattern = /([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(fragment))) result[match[1]] = decode(match[2]);
  return result;
}

function normalizeStatus(body: string): MergeTestStatus {
  if (/<skipped\b/.test(body)) return 'skipped';
  if (/<failure\b|<error\b/.test(body)) return 'failed';
  return 'passed';
}

function errorMessage(body: string): string {
  const failure = /<(?:failure|error)\b([^>]*)>([\s\S]*?)<\/(?:failure|error)>/.exec(body);
  if (!failure) return '';
  const message = attrs(failure[1]).message || '';
  const text = failure[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return (message || text).slice(0, 800);
}

function durationMs(body: string, allAttrs: Attrs): number {
  const seconds = Number(allAttrs.time || 0);
  if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000);
  const failure = /<(?:failure|error)\b([^>]*)>/.exec(body);
  const value = failure ? Number(attrs(failure[1]).time || 0) : 0;
  return Number.isFinite(value) && value > 0 ? Math.round(value * 1000) : 0;
}

export function parseJUnitReport(file: string): PlaywrightRun {
  const xml = fs.readFileSync(file, 'utf8');
  if (!/<testsuite\b|<testcase\b/.test(xml)) throw new Error('Not a JUnit XML report (missing testsuite/testcase)');
  const tests: PlaywrightRun['tests'] = [];
  const pattern = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml))) {
    const meta = attrs(match[1]);
    const body = match[2] || '';
    const status = normalizeStatus(body);
    const title = meta.name || '(unnamed test)';
    const filePath = meta.classname || meta.file || '';
    tests.push({
      file: filePath,
      title,
      titlePath: [filePath, title].filter(Boolean),
      project: meta.project || '',
      status,
      attempts: [{ status, durationMs: durationMs(body, meta), error: errorMessage(body) }],
    });
  }
  return {
    file,
    tests,
    stats: {
      expected: tests.filter((test) => test.status === 'passed').length,
      unexpected: tests.filter((test) => test.status === 'failed' || test.status === 'timedOut' || test.status === 'interrupted').length,
      flaky: 0,
      skipped: tests.filter((test) => test.status === 'skipped').length,
      durationMs: tests.reduce((sum, test) => sum + test.attempts.reduce((inner, attempt) => inner + attempt.durationMs, 0), 0),
    },
  };
}

/** True when a result file looks like JUnit XML rather than Playwright JSON. */
export function isJUnitReport(file: string): boolean {
  if (/\.xml$/i.test(file)) return true;
  try {
    const head = fs.readFileSync(file, 'utf8').trimStart();
    return head.startsWith('<') && /<testsuite\b|<testcase\b/.test(head.slice(0, 2000));
  } catch {
    return false;
  }
}
