/**
 * Error-text classifier: maps one recorded Playwright error message to a probable flake cause.
 *
 * Deterministic and explainable: a fixed, ordered probe list decides the class (the same order as
 * FLAKE_CLASSIFICATIONS), and the returned fragment is quoted from the input with credentials
 * redacted. There is no guessing from retries or durations here — only recorded text.
 */
import type { FlakeClassification } from './types.js';

interface Probe {
  classification: Exclude<FlakeClassification, 'unknown'>;
  patterns: RegExp[];
}

/**
 * Ordered probes. The first probe that matches wins, so "waiting for selector ... timeout" is
 * selector_drift (not timing) and "connect ECONNREFUSED" is network_fixture (not app_race).
 */
const PROBES: Probe[] = [
  {
    classification: 'network_fixture',
    patterns: [
      /\bERR_[A-Z0-9_]+\b/i,
      /\bECONN[A-Z]*\b/i,
      /\bENOTFOUND\b/i,
      /\bEAI_AGAIN\b/i,
      /\bETIMEDOUT\b/i,
      /\brequest failed\b/i,
      /\bnet::[A-Z0-9_]+\b/i,
      /\bfetch failed\b/i,
      /\bsocket hang up\b/i,
      /\bconnection (?:reset|refused|closed)\b/i,
      // A synthetic/recorded response that does not look like the app: only when the message
      // explicitly mentions a fixture/mock/stub/recording next to the 4xx/5xx status.
      /\b(?:fixture|mocked?|mocks|stub|recorded|replay)\b[^\n]{0,60}\b[45]\d\d\b/i,
      /\b[45]\d\d\b[^\n]{0,60}\b(?:fixture|mocked?|mocks|stub|recorded|replay)\b/i,
    ],
  },
  {
    classification: 'policy_block',
    patterns: [/\bpolicy\b/i, /\bsafety door\b/i, /\bdoor\b/i, /\bblocked\b/i, /\bPOLICY_VIOLATION\b/i, /\bdenied by\b/i],
  },
  {
    classification: 'selector_drift',
    patterns: [
      /\blocator\b/i,
      /\bwaiting for (?:selector|locator)\b/i,
      /\bstrict mode violation\b/i,
      /\bno element\b/i,
      /\bselector\b/i,
      /\belement (?:is )?not (?:visible|attached|enabled|found)\b/i,
      /\bresolved to \d+ elements\b/i,
    ],
  },
  {
    classification: 'timing',
    patterns: [/\btimeout\b/i, /\btimed out\b/i, /\bexceeded\b[^\n]{0,50}\b(?:time|budget|deadline|limit)\b/i],
  },
  {
    classification: 'app_race',
    patterns: [
      /\bexpect(?:ed|ation)?\b/i,
      /\bassert(?:ion|ed|s)?\b/i,
      /\btoBe\b/,
      /\btoEqual\b/,
      /\btoHave[A-Za-z]*\b/,
      /\btoContain[A-Za-z]*\b/,
      /\breceived\b/i,
      /\b5\d\d\b/,
      /\bmismatch\b/i,
    ],
  },
];

const SECRET_REDACTIONS: Array<[RegExp, string]> = [
  [/(sk_live_|sk_test_|rk_live_|pk_live_|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{4,}/g, '$1[redacted]'],
  [/\bAKIA[0-9A-Z]{12,}\b/g, 'AKIA[redacted]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]'],
  [/((?:password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[redacted]'],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, '[jwt redacted]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, '[private key redacted]'],
];

const MAX_FRAGMENT = 140;

/** Collapse to one line, redact credentials and cap the length. Never returns markup. */
export function redactEvidenceText(text: string): string {
  let value = String(text ?? '');
  for (const [pattern, replacement] of SECRET_REDACTIONS) value = value.replace(pattern, replacement);
  value = value.replace(/\s+/g, ' ').trim();
  if (value.length > MAX_FRAGMENT) value = value.slice(0, MAX_FRAGMENT - 1).trimEnd() + '…';
  return value;
}

/** The quoted fragment around a match, ready for the evidence list. */
function quoteAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 35);
  const end = Math.min(text.length, index + length + 60);
  return `"${redactEvidenceText(text.slice(start, end))}"`;
}

export interface ClassifiedError {
  classification: FlakeClassification;
  evidence: string;
}

/**
 * Classify one recorded error message. Returns null when no probe matches the text (the caller
 * turns a test with no matched error into 'unknown' with no evidence rather than inventing it).
 */
export function classifyErrorText(error: string): ClassifiedError | null {
  if (typeof error !== 'string' || error.trim() === '') return null;
  for (const probe of PROBES) {
    for (const pattern of probe.patterns) {
      const match = pattern.exec(error);
      if (match) return { classification: probe.classification, evidence: quoteAround(error, match.index, match[0].length) };
    }
  }
  return null;
}

/**
 * Classify a list of errors and return the priority-selected class plus its evidence.
 * All observed classes are returned so the analyzer can tell a consistent class from a mixed one.
 */
export function classifyErrors(errors: string[]): {
  classification: FlakeClassification;
  classes: FlakeClassification[];
  evidence: string[];
} {
  const seen = new Map<FlakeClassification, Set<string>>();
  for (const error of errors) {
    const classified = classifyErrorText(error);
    if (!classified) continue;
    const fragments = seen.get(classified.classification) ?? new Set<string>();
    fragments.add(classified.evidence);
    seen.set(classified.classification, fragments);
  }
  const classes = [...seen.keys()];
  if (classes.length === 0) return { classification: 'unknown', classes: [], evidence: [] };
  // Deterministic priority: the first class in the canonical order wins.
  const classification = FLAKE_ORDER.find((candidate) => seen.has(candidate)) ?? 'unknown';
  const evidence = [...(seen.get(classification) ?? [])].sort().slice(0, 3);
  return { classification, classes, evidence };
}

/** Canonical priority order for classes (kept here so the analyzer and classifier cannot drift). */
export const FLAKE_ORDER: readonly FlakeClassification[] = [
  'network_fixture',
  'policy_block',
  'selector_drift',
  'timing',
  'app_race',
  'unknown',
];
