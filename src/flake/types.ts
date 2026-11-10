/**
 * Shared types for `airlock flake`: deterministic aggregation of `AirlockRunReport` manifests.
 *
 * The engine is pure: it reads reporter manifests (src/testing/airlock-report.ts) and returns a
 * verdict per test. No CLI, no network, no signing, no timestamps invented from outside the input.
 */

/** Probable cause of an unstable test, from recorded error text only. Priority order is the order here. */
export type FlakeClassification =
  | 'network_fixture'
  | 'selector_drift'
  | 'timing'
  | 'app_race'
  | 'policy_block'
  | 'unknown';

/** All classifications, in deterministic priority order (used for ties and totals). */
export const FLAKE_CLASSIFICATIONS: readonly FlakeClassification[] = [
  'network_fixture',
  'policy_block',
  'selector_drift',
  'timing',
  'app_race',
  'unknown',
] as const;

export type FlakeConfidence = 'high' | 'medium' | 'low';

export const FLAKE_CONFIDENCES: readonly FlakeConfidence[] = ['high', 'medium', 'low'] as const;

/** One test across every analyzed run. */
export interface FlakeTestSummary {
  id: string;
  title: string;
  titlePath: string[];
  file: string;
  project: string;
  /** Non-skipped appearances of this test across the analyzed reports. */
  runs: number;
  /** Runs whose final status was passed. */
  passes: number;
  /** Runs whose final status was failed/timedOut/interrupted. */
  failures: number;
  /** Sum of recorded retry attempts across runs. */
  retries: number;
  /** Runs with evidence of instability: a failed run, or a run that only passed after retries. */
  flakeCount: number;
  /** flakeCount / runs (0 when the test never ran). */
  flakeRate: number;
  classification: FlakeClassification;
  confidence: FlakeConfidence;
  /** Short, redacted quotes from the recorded error text that drove the classification. */
  evidence: string[];
  owner?: string;
  quarantined: boolean;
  /** Where the cause came from: recorded error text, or a request ledger recorded by the attach fixture. */
  evidenceTier?: 'error-text' | 'request-ledger';
  /** Ledger summary when evidenceTier is request-ledger. */
  ledger?: { requests: number; failures: number; missing: number };
}

/** The whole analysis for one set of reports. */
export interface FlakeAnalysis {
  generatedAt: string;
  /** Reports analyzed after duplicate runIds were dropped. */
  reports: number;
  minRuns: number;
  totalTests: number;
  flakyTests: number;
  totals: Record<FlakeClassification, number>;
  tests: FlakeTestSummary[];
  quarantine: FlakeTestSummary[];
  warnings: string[];
}

export interface FlakeOptions {
  /** Minimum appearances before a test can be quarantined (default 1). */
  minRuns?: number;
  /** Quarantine when flakeCount/runs is at least this (default 0.2, 0..1). */
  flakeThreshold?: number;
  /** ownerMap[id] wins over ownerMap[file]; unknown ids fall back to no owner. */
  ownerMap?: Record<string, string>;
}

/** Defaults, exported so the CLI/reporting layer can document them without copying numbers. */
export const FLAKE_DEFAULTS = {
  minRuns: 1,
  flakeThreshold: 0.2,
} as const;
