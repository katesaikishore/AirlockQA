/**
 * Request-ledger evidence for `airlock flake`.
 *
 * The attach determinism fixture writes a ledger per test (`.airlock/ledgers/<hash>.json`) recording
 * every http(s) request made through the browser context, plus failures and missing replay entries.
 * When a ledger exists, flake marks the cause as `request-ledger` evidence instead of pure error-text
 * inference: a recorded failed request confirms network_fixture, and a clean ledger downgrades a
 * network classification that the recorded error text alone would have over-read.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { redactEvidenceText } from './classify.js';
import type { FlakeAnalysis, FlakeTestSummary } from './types.js';

export interface FlakeLedger {
  testId: string;
  title: string;
  file?: string;
  titlePath?: string[];
  mode?: string;
  requests: number;
  failures: { url: string; status?: number; error?: string }[];
  missing: number;
}

/** Read every ledger JSON in a directory (or a single file); malformed entries are ignored. */
export function readFlakeLedgers(dir: string): FlakeLedger[] {
  if (!fs.existsSync(dir)) return [];
  const files = fs.statSync(dir).isDirectory()
    ? fs.readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => path.join(dir, name))
    : [dir];
  const ledgers: FlakeLedger[] = [];
  for (const file of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object') continue;
      const value = parsed as FlakeLedger;
      if (typeof value.title !== 'string' || typeof value.requests !== 'number' || !Array.isArray(value.failures)) continue;
      ledgers.push(value);
    } catch {
      // A truncated ledger is not evidence; skip it.
    }
  }
  return ledgers;
}

function ledgerKey(file: string | undefined, title: string): string {
  const base = file ? path.basename(file) : '';
  return `${base}::${title}`.toLowerCase();
}

function lastTitlePart(title: string): string {
  const parts = title.split(' › ');
  return parts[parts.length - 1] || title;
}

/** Return a copy of the analysis annotated with ledger evidence. Pure: inputs are not mutated. */
export function applyLedgerEvidence(analysis: FlakeAnalysis, ledgers: FlakeLedger[]): FlakeAnalysis {
  if (!ledgers.length) return analysis;
  const byKey = new Map<string, FlakeLedger>();
  for (const ledger of ledgers) {
    byKey.set(ledgerKey(ledger.file, lastTitlePart(ledger.title)), ledger);
  }

  const tests = analysis.tests.map((test): FlakeTestSummary => {
    const ledger = byKey.get(ledgerKey(test.file, test.title));
    if (!ledger) return test;
    const failures = ledger.failures.length;
    const evidence = [...test.evidence];
    for (const failure of ledger.failures.slice(0, 2)) {
      const detail = failure.status ? `status ${failure.status}` : failure.error || 'recorded failure';
      evidence.push(redactEvidenceText(`ledger: ${failure.url} → ${detail}`));
    }
    if (!failures) evidence.push(redactEvidenceText(`ledger: ${ledger.requests} request(s), no failures, missing replay entries ${ledger.missing}`));

    let classification = test.classification;
    let confidence = test.confidence;
    if (failures > 0 && classification !== 'network_fixture' && (classification === 'unknown' || classification === 'timing')) {
      // The ledger has a recorded transport failure but the error text did not name it (or named a
      // timeout): the ledger is stronger evidence than the generic message.
      classification = 'network_fixture';
      confidence = 'high';
      evidence.push('ledger reclassified this failure as network_fixture');
    }
    if (classification === 'network_fixture' && failures === 0 && ledger.requests > 0) {
      // The error text looked network-shaped and traffic was actually recorded without a failure:
      // stop over-reading the text.
      confidence = 'low';
      evidence.push('ledger conflicts with error text: no failed requests recorded');
    } else if (classification === 'network_fixture' && failures === 0) {
      // No browser traffic to confirm or contradict (for example a pre-browser assertion failure):
      // the ledger is silent, so leave the error-text confidence alone.
      evidence.push('ledger: no network traffic recorded for this test');
    } else if (classification === 'network_fixture' && failures > 0) {
      confidence = 'high';
    } else if (failures === 0 && ledger.requests > 0 && (classification === 'selector_drift' || classification === 'timing' || classification === 'app_race')) {
      confidence = confidence === 'high' ? 'high' : 'medium';
    }
    return {
      ...test,
      classification,
      confidence,
      evidence: evidence.slice(0, 4),
      evidenceTier: 'request-ledger',
      ledger: { requests: ledger.requests, failures, missing: ledger.missing },
    };
  });

  return { ...analysis, tests };
}
