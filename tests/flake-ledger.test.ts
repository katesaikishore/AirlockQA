import { describe, expect, it } from 'bun:test';
import { analyzeFlakiness, renderFlakeMarkdown } from '../src/flake/index.js';
import { applyLedgerEvidence, readFlakeLedgers, type FlakeLedger } from '../src/flake/ledger.js';
import { AIRLOCK_REPORT_VERSION, type AirlockReportTest, type AirlockRunReport } from '../src/testing/airlock-report.js';

function report(runId: string, tests: AirlockReportTest[]): AirlockRunReport {
  return {
    version: AIRLOCK_REPORT_VERSION,
    tool: 'airlock-reporter',
    runId,
    startedAt: `2026-01-01T00:0${runId.slice(-1)}:00.000Z`,
    finishedAt: `2026-01-01T00:0${runId.slice(-1)}:01.000Z`,
    durationMs: 1000,
    tests,
  };
}

function test(id: string, status: 'passed' | 'failed', errors: string[] = []): AirlockReportTest {
  return {
    id,
    title: 'cart works',
    titlePath: ['tests/cart.spec.ts', 'cart works'],
    file: 'cart.spec.ts',
    project: 'default',
    status,
    retries: 0,
    durationMs: 100,
    errors,
  };
}

function ledger(overrides: Partial<FlakeLedger> = {}): FlakeLedger {
  return {
    testId: 'abc',
    title: 'tests/cart.spec.ts › cart works',
    file: 'cart.spec.ts',
    mode: 'replay',
    requests: 4,
    failures: [],
    missing: 0,
    ...overrides,
  };
}

const id = 'default::cart.spec.ts::tests/cart.spec.ts › cart works';
const reports = [
  report('run-1', [test(id, 'failed', ['net::ERR_CONNECTION_REFUSED request failed GET /api/cart'])]),
  report('run-2', [test(id, 'passed')]),
  report('run-3', [test(id, 'passed')]),
];

describe('flake request-ledger evidence', () => {
  it('confirms a network cause from a recorded transport failure', () => {
    const analysis = analyzeFlakiness(reports);
    const enriched = applyLedgerEvidence(analysis, [ledger({ failures: [{ url: 'https://shop.test/api/cart', error: 'net::ERR_CONNECTION_REFUSED' }] })]);
    const entry = enriched.tests.find((candidate) => candidate.id === id);
    expect(entry?.evidenceTier).toBe('request-ledger');
    expect(entry?.classification).toBe('network_fixture');
    expect(entry?.confidence).toBe('high');
    expect(entry?.ledger).toEqual({ requests: 4, failures: 1, missing: 0 });
    expect(entry?.evidence.some((line) => line.includes('ledger: https://shop.test/api/cart'))).toBe(true);
    expect(renderFlakeMarkdown(enriched)).toContain('Request-ledger evidence');
  });

  it('leaves text confidence alone when the ledger has no traffic (silent ledger)', () => {
    const analysis = analyzeFlakiness(reports);
    const enriched = applyLedgerEvidence(analysis, [ledger({ requests: 0, failures: [] })]);
    const entry = enriched.tests.find((candidate) => candidate.id === id);
    expect(entry?.evidenceTier).toBe('request-ledger');
    expect(entry?.confidence).not.toBe('low');
    expect(entry?.evidence.some((line) => line.includes('no network traffic'))).toBe(true);
    expect(renderFlakeMarkdown(enriched)).not.toContain('## Request-ledger evidence');
  });

  it('downgrades a network label when recorded traffic succeeded', () => {
    const analysis = analyzeFlakiness(reports);
    const enriched = applyLedgerEvidence(analysis, [ledger({ requests: 6, failures: [] })]);
    const entry = enriched.tests.find((candidate) => candidate.id === id);
    expect(entry?.confidence).toBe('low');
    expect(entry?.evidence.some((line) => line.includes('no failed requests'))).toBe(true);
  });

  it('reclassifies an unlabelled failure when the ledger recorded a transport failure', () => {
    const silent = [
      report('run-1', [test(id, 'failed', [])]),
      report('run-2', [test(id, 'passed')]),
      report('run-3', [test(id, 'passed')]),
    ];
    const analysis = analyzeFlakiness(silent);
    const enriched = applyLedgerEvidence(analysis, [ledger({ failures: [{ url: 'https://shop.test/api/cart', error: 'ECONNRESET' }] })]);
    const entry = enriched.tests.find((candidate) => candidate.id === id);
    expect(entry?.classification).toBe('network_fixture');
    expect(entry?.confidence).toBe('high');
  });

  it('reads ledger files from disk and ignores malformed entries', () => {
    const dir = `/tmp/airlock-flake-ledger-${Date.now()}`;
    const fs = require('node:fs') as typeof import('node:fs');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/one.json`, JSON.stringify(ledger()));
    fs.writeFileSync(`${dir}/bad.json`, '{not json');
    const ledgers = readFlakeLedgers(dir);
    expect(ledgers).toHaveLength(1);
    expect(ledgers[0].requests).toBe(4);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
