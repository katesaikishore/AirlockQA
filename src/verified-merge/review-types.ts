/** QA-focused PR review domain. Kept separate from the Investigator so both can share LLM plumbing. */
export const REVIEW_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];

export const REVIEW_CATEGORIES = [
  'correctness',
  'security',
  'tests',
  'reliability',
  'accessibility',
  'performance',
  'maintainability',
] as const;
export type ReviewCategory = (typeof REVIEW_CATEGORIES)[number];

export interface DiffLine {
  /** New-file line number (1-based). */
  line: number;
  content: string;
}

export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: 'added' | 'removed' | 'modified' | 'renamed';
  addedLines: DiffLine[];
  removedLines: DiffLine[];
  /** Raw unified-diff body for this file, bounded by the parser. */
  patch: string;
}

export interface PullRequestInput {
  repo: string;
  number: number;
  url?: string;
  title?: string;
  body?: string;
  author?: string;
  baseSha?: string;
  headSha?: string;
  baseRef?: string;
  headRef?: string;
}

export interface ReviewInput {
  pullRequest?: PullRequestInput;
  files: ChangedFile[];
  /** Paths in the repo that look like tests (from the diff or caller-provided context). */
  testFiles?: string[];
  /** Deterministic checks and the model both receive the bounded diff, not the whole repo. */
  patch: string;
  truncated?: boolean;
  /** Repository-wide review instructions from .airlock-review.yml. */
  instructions?: string;
  /** Per-path instructions from .airlock-review.yml that match this diff. */
  pathInstructions?: string[];
  /** Repo-scoped learnings from accepted/rejected findings. */
  learnings?: string[];
  /** Human APPROVED review count fetched by the worker (bots excluded). */
  approvals?: number;
  /** Logins of unique human approvers. */
  approvedBy?: string[];
  /** Bounded repository context gathered by the worker (tree/test list/full file bodies). */
  repoContext?: RepoContext;
}

export interface RepoContext {
  tree?: string[];
  testFiles?: string[];
  files?: Array<{ path: string; content: string }>;
  packageScripts?: Record<string, string>;
  truncated?: boolean;
}

export interface ReviewFinding {
  id: string;
  file: string;
  line?: number;
  severity: ReviewSeverity;
  category: ReviewCategory;
  title: string;
  body: string;
  suggestion?: string;
  /** Exact single-line replacement rendered as a GitHub suggestion block (one-click apply). */
  suggestedCode?: string;
  /** The added line the suggestion replaces, used as a safety guard when applying. */
  originalLine?: string;
  confidence: number;
  source: 'deterministic' | 'llm';
  verified: boolean;
  evidence?: string;
}

export interface PreMergeCheckView {
  id: string;
  title: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  detail: string;
}

export interface ReviewWalkthroughSection {
  title: string;
  body: string;
}

export interface ReviewUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  calls: number;
  estimatedCostUsd?: number;
}

export interface ReviewModelInfo {
  provider: string;
  model: string;
}

export type ReviewModelStatus = 'used' | 'skipped' | 'error';

export interface ReviewReport {
  version: '1.0.0';
  generatedAt: string;
  pullRequest?: PullRequestInput;
  summary: string;
  walkthrough: ReviewWalkthroughSection[];
  findings: ReviewFinding[];
  checks?: PreMergeCheckView[];
  stats: {
    filesChanged: number;
    addedLines: number;
    removedLines: number;
    deterministicFindings: number;
    llmFindings: number;
    droppedFindings: number;
    verifiedFindings: number;
  };
  model?: ReviewModelInfo;
  modelStatus: ReviewModelStatus;
  usage?: ReviewUsage;
  warnings: string[];
}

export function severityRank(severity: ReviewSeverity): number {
  return REVIEW_SEVERITIES.indexOf(severity);
}

/** Fail on any finding at or above this severity, or never for 'none'. */
export type FailOn = ReviewSeverity | 'none';

export function shouldFail(report: ReviewReport, failOn: FailOn): boolean {
  if (failOn === 'none') return false;
  const threshold = severityRank(failOn);
  return report.findings.some((finding) => severityRank(finding.severity) <= threshold);
}
