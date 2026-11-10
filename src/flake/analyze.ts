/**
 * `airlock flake` analysis engine.
 *
 * Input: the reporter manifests (`AirlockRunReport`) written by the Playwright reporter across
 * many runs. Output: one deterministic verdict per test id — no reruns, no guessing, no invented
 * numbers. The only non-input value is `generatedAt`, the moment this analysis was computed.
 *
 * Rules (see docs/product-roadmap.md P0 #2):
 * - Group by test id across reports.
 * - Flaky = at least one failed run and at least one passed run, or a run that only passed after
 *   retries. Stable failures are not flaky but keep their classification in `totals`.
 * - flakeCount = failed runs + runs that needed retries to pass; flakeRate = flakeCount / runs.
 * - Quarantine = flaky, runs >= minRuns and flakeRate >= flakeThreshold.
 */
import type { AirlockReportTest, AirlockRunReport } from '../testing/airlock-report.js';
import { classifyErrors } from './classify.js';
import {
  FLAKE_CLASSIFICATIONS,
  FLAKE_DEFAULTS,
  type FlakeAnalysis,
  type FlakeClassification,
  type FlakeConfidence,
  type FlakeOptions,
  type FlakeTestSummary,
} from './types.js';

interface Group {
  id: string;
  entries: AirlockReportTest[];
}

function isFailedStatus(status: AirlockReportTest['status']): boolean {
  return status === 'failed' || status === 'timedOut' || status === 'interrupted';
}

function normaliseRetries(test: AirlockReportTest): number {
  const value = Number(test.retries);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function titlePathOf(test: AirlockReportTest): string[] {
  if (Array.isArray(test.titlePath) && test.titlePath.length > 0) return test.titlePath.map((part) => String(part));
  return test.title ? [String(test.title)] : [];
}

function emptyTotals(): Record<FlakeClassification, number> {
  const totals = {} as Record<FlakeClassification, number>;
  for (const classification of FLAKE_CLASSIFICATIONS) totals[classification] = 0;
  return totals;
}

function validateOptions(options: FlakeOptions): { minRuns: number; flakeThreshold: number; ownerMap: Record<string, string> } {
  if (options === null || typeof options !== 'object') throw new Error('options must be an object');
  const minRuns = options.minRuns ?? FLAKE_DEFAULTS.minRuns;
  if (!Number.isInteger(minRuns) || minRuns < 1) throw new Error('minRuns must be a positive integer');
  const flakeThreshold = options.flakeThreshold ?? FLAKE_DEFAULTS.flakeThreshold;
  if (typeof flakeThreshold !== 'number' || !Number.isFinite(flakeThreshold) || flakeThreshold < 0 || flakeThreshold > 1) {
    throw new Error('flakeThreshold must be a number between 0 and 1');
  }
  const ownerMap = options.ownerMap ?? {};
  if (ownerMap === null || typeof ownerMap !== 'object' || Array.isArray(ownerMap)) throw new Error('ownerMap must be an object of id/file → owner');
  return { minRuns, flakeThreshold, ownerMap };
}

/** Attach an owner from the map: the test id wins over its file. */
function ownerFor(id: string, file: string, ownerMap: Record<string, string>): string | undefined {
  const byId = ownerMap[id];
  if (typeof byId === 'string' && byId.trim() !== '') return byId;
  const byFile = file ? ownerMap[file] : undefined;
  if (typeof byFile === 'string' && byFile.trim() !== '') return byFile;
  return undefined;
}

/**
 * Confidence in the verdict.
 *
 * Interpretation of the contract wording ("high when >=3 runs and a consistent class; medium when
 * 2 runs or mixed classes; low for minRuns below 3 or unknown class"): confidence is a property of
 * the evidence for one test, so it follows the number of observed runs for that test. A run count
 * below 3 cannot be high; 2 runs or mixed classes is medium; a single run or an unmapped cause is
 * low. The `minRuns` option is the quarantine/warning floor, not a multiplier on confidence.
 */
function confidenceFor(classification: FlakeClassification, runs: number, mixedClasses: boolean): FlakeConfidence {
  if (classification === 'unknown') return 'low';
  if (runs >= 3 && !mixedClasses) return 'high';
  if (runs === 2 || mixedClasses) return 'medium';
  // A single observation cannot support a confident verdict.
  return 'low';
}

function sortTests(tests: FlakeTestSummary[]): FlakeTestSummary[] {
  return [...tests].sort((a, b) => {
    if (a.quarantined !== b.quarantined) return a.quarantined ? -1 : 1;
    const aFlaky = a.flakeCount > 0 && a.passes > 0 ? 1 : 0;
    const bFlaky = b.flakeCount > 0 && b.passes > 0 ? 1 : 0;
    if (aFlaky !== bFlaky) return bFlaky - aFlaky;
    if (a.flakeRate !== b.flakeRate) return b.flakeRate - a.flakeRate;
    if (a.flakeCount !== b.flakeCount) return b.flakeCount - a.flakeCount;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Aggregate reporter manifests into a per-test flake verdict.
 *
 * Reports are assumed to be in the order the caller wants them treated (readRunReports returns
 * newest first); a duplicate `runId` is ignored after the first appearance so one CI run cannot
 * be counted twice, and a warning says so.
 */
export function analyzeFlakiness(reports: AirlockRunReport[], options: FlakeOptions = {}): FlakeAnalysis {
  if (!Array.isArray(reports)) throw new Error('reports must be an array of AirlockRunReport');
  const { minRuns, flakeThreshold, ownerMap } = validateOptions(options);
  const generatedAt = new Date().toISOString();
  const warnings: string[] = [];

  const seenRunIds = new Set<string>();
  const analyzed: AirlockRunReport[] = [];
  for (const report of reports) {
    if (!report || typeof report !== 'object' || Array.isArray(report)) {
      warnings.push('Ignoring a report that is not an AirlockRunReport object.');
      continue;
    }
    const runId = typeof report.runId === 'string' ? report.runId : '';
    if (runId && seenRunIds.has(runId)) {
      warnings.push(`Duplicate runId "${runId}"; the later report was ignored.`);
      continue;
    }
    if (runId) seenRunIds.add(runId);
    analyzed.push(report);
  }

  if (analyzed.length === 0) {
    return {
      generatedAt,
      reports: 0,
      minRuns,
      totalTests: 0,
      flakyTests: 0,
      totals: emptyTotals(),
      tests: [],
      quarantine: [],
      warnings: ['No reports were provided; nothing to analyze.', ...warnings],
    };
  }

  for (const report of analyzed) {
    if (!Array.isArray(report.tests) || report.tests.length === 0) warnings.push(`Report "${report.runId}" has no tests.`);
  }

  const groups = new Map<string, Group>();
  for (const report of analyzed) {
    for (const test of report.tests ?? []) {
      if (!test || typeof test !== 'object') continue;
      const fallbackId = `${test.project ?? ''}::${test.file ?? ''}::${titlePathOf(test).join(' › ')}`;
      const id = typeof test.id === 'string' && test.id.trim() !== '' ? test.id : fallbackId;
      const group = groups.get(id) ?? { id, entries: [] };
      group.entries.push(test);
      groups.set(id, group);
    }
  }

  const totals = emptyTotals();
  const tests: FlakeTestSummary[] = [];
  for (const group of groups.values()) {
    const first = group.entries[0];
    let runs = 0;
    let passes = 0;
    let failures = 0;
    let retries = 0;
    let retriedPasses = 0;
    const failedAttemptErrors: string[] = [];

    for (const entry of group.entries) {
      if (entry.status === 'skipped') continue;
      const entryRetries = normaliseRetries(entry);
      runs += 1;
      retries += entryRetries;
      if (entry.status === 'passed') {
        passes += 1;
        if (entryRetries > 0) retriedPasses += 1;
      } else {
        failures += 1;
      }
      // Errors are only evidence of a failure attempt: a failed run, or a pass that needed retries.
      if (isFailedStatus(entry.status) || (entry.status === 'passed' && entryRetries > 0)) {
        for (const error of Array.isArray(entry.errors) ? entry.errors : []) {
          if (typeof error === 'string' && error.trim() !== '') failedAttemptErrors.push(error);
        }
      }
    }

    const flakeCount = failures + retriedPasses;
    const flakeRate = runs > 0 ? flakeCount / runs : 0;
    const flaky = retriedPasses > 0 || (failures > 0 && passes > 0);
    const { classification, classes, evidence } = classifyErrors(failedAttemptErrors);
    const mixedClasses = classes.length > 1;
    const confidence = confidenceFor(classification, runs, mixedClasses);
    const file = typeof first.file === 'string' ? first.file : '';
    const owner = ownerFor(group.id, file, ownerMap);
    const quarantined = flaky && runs >= minRuns && flakeRate >= flakeThreshold;
    const summary: FlakeTestSummary = {
      id: group.id,
      title: typeof first.title === 'string' ? first.title : titlePathOf(first).join(' › '),
      titlePath: titlePathOf(first),
      file,
      project: typeof first.project === 'string' ? first.project : '',
      runs,
      passes,
      failures,
      retries,
      flakeCount,
      flakeRate,
      classification,
      confidence,
      evidence,
      ...(owner !== undefined ? { owner } : {}),
      quarantined,
      evidenceTier: 'error-text' as const,
    };
    totals[classification] += 1;
    tests.push(summary);
  }

  const sorted = sortTests(tests);
  const flakyTests = sorted.filter((test) => test.flakeCount > 0 && test.passes > 0).length;
  for (const test of sorted) {
    if (test.runs < minRuns) {
      const label = test.titlePath.length > 0 ? test.titlePath.join(' › ') : test.title;
      warnings.push(`Test "${label}" appears in ${test.runs} run(s), fewer than minRuns (${minRuns}).`);
    }
  }
  const quarantine = sorted.filter((test) => test.quarantined);
  return { generatedAt, reports: analyzed.length, minRuns, totalTests: sorted.length, flakyTests, totals, tests: sorted, quarantine, warnings };
}
