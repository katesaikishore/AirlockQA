/**
 * Pure helpers for the console's QA screens: form validation that mirrors cloud/shared/contract.ts
 * (CreateQaRunBodySchema), error wording, analytics formatting and the in-browser seal check.
 * No React and no DOM here, so the bun tests in tests/console-qa.test.ts can run it directly.
 * Nothing is imported from the server contract at runtime: zod is not bundled into the console.
 * The constants below are a copy; tests/console-qa.test.ts fails if they drift from the contract.
 */

export const QA_SUITES = ['unit', 'integration', 'e2e', 'smoke', 'explore', 'a11y', 'security', 'load'] as const;
export type QaSuite = (typeof QA_SUITES)[number];
export const QA_GATES = ['strict', 'default'] as const;
export type QaGate = (typeof QA_GATES)[number];
export const QA_SCRIPT_NAMES = [
  'install', 'build', 'start', 'test', 'test:integration', 'test:e2e', 'test:a11y', 'test:security', 'test:load', 'test:explore',
] as const;
/**
 * Suites that run only when the request names a script for them (scripts['test:<suite>']). explore is not here: without
 * a script it runs Airlock's own checker.
 */
export const QA_SCRIPTED_SUITES = ['a11y', 'security', 'load'] as const;
const HEALTH_PATH_RE = /^\/[A-Za-z0-9._~/-]{0,200}$/;
export type QaScriptName = (typeof QA_SCRIPT_NAMES)[number];

export const QA_SCRIPT_NAME_RE = /^[a-z0-9][a-z0-9:_-]{0,39}$/;
const SHA40_RE = /^[0-9a-f]{40}$/;
const PUBLIC_REPO_RE = /^https:\/\/github\.com\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]+$/;
const MAX_SUITES = 8;

export interface QaFormInput {
  repo: string;
  sha: string;
  branch: string;
  suites: string[];
  gate: string;
  scripts: Record<QaScriptName, string>;
  /** Optional: the path the health check asks for (default "/"). */
  healthPath?: string;
  /** Optional: the port the app listens on inside the sandbox (default 3000). */
  port?: string;
  continueOnFailure?: boolean;
}

/** The request body POST /v1/qa-runs accepts. Optional keys are left out when empty. */
export interface QaRunRequest {
  repo: string;
  sha: string;
  branch?: string;
  suites: QaSuite[];
  gate: QaGate;
  scripts: Partial<Record<QaScriptName, string>>;
  healthPath?: string;
  port?: number;
  continueOnFailure?: boolean;
}

export type QaFormErrors = Partial<Record<'repo' | 'sha' | 'branch' | 'suites' | 'gate' | 'healthPath' | 'port' | `scripts.${QaScriptName}`, string>>;

export type QaFormResult = { ok: true; body: QaRunRequest } | { ok: false; errors: QaFormErrors };

export function validateQaForm(input: QaFormInput): QaFormResult {
  const errors: QaFormErrors = {};
  const repo = input.repo.trim();
  if (!PUBLIC_REPO_RE.test(repo) || repo.includes('..')) {
    errors.repo = 'Use a public GitHub repository URL, for example https://github.com/owner/repo.';
  }
  const sha = input.sha.trim();
  if (!SHA40_RE.test(sha)) {
    errors.sha = 'Use the full 40-character commit SHA in lowercase hex.';
  }
  const branch = input.branch.trim();
  if (branch && (branch.length > 100 || !BRANCH_RE.test(branch))) {
    errors.branch = 'Branch names may use letters, digits, dot, underscore, slash and dash (up to 100 characters).';
  }
  const suites = input.suites.filter((suite): suite is QaSuite => (QA_SUITES as readonly string[]).includes(suite));
  if (suites.length === 0 || suites.length !== input.suites.length || suites.length > MAX_SUITES) {
    errors.suites = 'Choose at least one suite.';
  }
  const gate = input.gate as QaGate;
  if (!(QA_GATES as readonly string[]).includes(gate)) {
    errors.gate = 'Choose strict or default.';
  }
  const scripts: Partial<Record<QaScriptName, string>> = {};
  for (const name of QA_SCRIPT_NAMES) {
    const value = (input.scripts[name] || '').trim();
    if (!value) continue;
    if (!QA_SCRIPT_NAME_RE.test(value)) {
      errors[`scripts.${name}`] = 'Use an npm script name: lowercase letters, digits, colon, dash or underscore.';
    } else {
      scripts[name] = value;
    }
  }
  const healthPath = (input.healthPath || '').trim();
  if (healthPath && !HEALTH_PATH_RE.test(healthPath)) {
    errors.healthPath = 'Use a path that starts with /, for example /health.';
  }
  const portText = (input.port || '').trim();
  const port = portText ? Number(portText) : undefined;
  if (portText && !(/^\d{4,5}$/.test(portText) && (port as number) >= 1024 && (port as number) <= 65535)) {
    errors.port = 'Use a port number from 1024 to 65535.';
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const body: QaRunRequest = { repo, sha, suites, gate, scripts };
  if (port !== undefined) body.port = port;
  if (branch) body.branch = branch;
  if (healthPath) body.healthPath = healthPath;
  if (input.continueOnFailure) body.continueOnFailure = true;
  return { ok: true, body };
}

/** Requested suites that need a script name but have none: they would be reported NOT_RUN. */
export function scriptedSuitesWithoutScript(suites: string[], scripts: Partial<Record<QaScriptName, string>>): string[] {
  return suites.filter(
    (suite) => (QA_SCRIPTED_SUITES as readonly string[]).includes(suite) && !(scripts[`test:${suite}` as QaScriptName] || '').trim(),
  );
}

/** Wording for an error from the QA API. Quota (402) and concurrency (429) show the server's own message. */
export function describeQaError(error: unknown): string {
  const info = (error || {}) as { message?: unknown; retryAfter?: unknown };
  const message = typeof info.message === 'string' && info.message.trim() ? info.message.trim() : 'Something went wrong. Try again.';
  const retry = typeof info.retryAfter === 'number' && info.retryAfter > 0 ? ` Try again in ${Math.ceil(info.retryAfter)} seconds.` : '';
  return message + retry;
}

// ---------------------------------------------------------------------------
// Response shapes (what the QA endpoints return; the list and analytics endpoints are built by another track).
// ---------------------------------------------------------------------------

export interface QaSuiteOutcome {
  suite: string;
  status: string;
  /** Failing test names and other reasons for this suite's status. */
  reasons?: string[];
}

export interface QaRunSummary {
  id: string;
  status: string;
  phase: string | null;
  repo?: string | null;
  sha?: string | null;
  branch?: string | null;
  suites: QaSuiteOutcome[];
  /** strict or default, as requested. Absent when the server does not report it. */
  gateMode?: string | null;
  gate: { exitCode: number; reasons: string[]; continueOnFailure?: boolean } | null;
  createdAt?: string | null;
  finishedAt?: string | null;
  error?: string | null;
}

/** A finding stored for a run. Origin is always sandbox self-reported: it comes from the app's own test output. */
export interface QaFinding {
  klass: string;
  severity: string;
  origin: string;
  route: string;
  assertion: string;
  fingerprint: string;
}

export interface QaRunDetail extends QaRunSummary {
  /** The sealed result: { algorithm, seal, signature, publicKeyPem, keyId? }. Null until the run finishes. */
  evidence: unknown | null;
  findings?: QaFinding[];
}

export interface QaAnalytics {
  failRate: { failed: number; total: number };
  flakeRate: { flaky: number; total: number };
  hotspots: Array<{ suite: string; failures: number }>;
  runs?: number;
  suiteResults?: number;
  /** One entry per distinct bug (fingerprint): the commit it was first seen on and how many runs it has stayed open. */
  findings?: Array<{
    fingerprint: string;
    firstSeenSha: string;
    buildsOpen: number;
    klass?: string;
    severity?: string;
    assertion?: string;
    route?: string;
  }>;
}

/** PASS, FAIL, NOT_RUN and FLAKY are the statuses the console shows. Anything else is UNKNOWN, never a pass. */
export function suiteStatusLabel(status: string | null | undefined): 'PASS' | 'FAIL' | 'FLAKY' | 'NOT RUN' | 'UNKNOWN' {
  switch (status) {
    case 'PASS': return 'PASS';
    case 'FAIL': return 'FAIL';
    case 'FLAKY': return 'FLAKY';
    case 'NOT_RUN': return 'NOT RUN';
    default: return 'UNKNOWN';
  }
}

/**
 * "2 of 10 suite results (20%)", or a plain note when nothing has finished yet. The API counts suite results (one per
 * suite per finished run), not runs.
 */
export function formatRatio(part: { failed?: number; flaky?: number; total: number }, key: 'failed' | 'flaky'): string {
  const total = Number(part.total) || 0;
  if (total <= 0) return 'No finished runs yet';
  const count = Number(part[key]) || 0;
  return `${count} of ${total} suite results (${Math.round((count / total) * 100)}%)`;
}

/** "owner/repo" for a GitHub URL; anything else unchanged. */
export function shortRepo(url: string): string {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url);
  return m ? m[1] : url;
}

/** A reason line without the long rules Playwright draws after a test title ("──────"). */
/** Who saw a finding: Airlock's checker (first-party) or the app's own tests (self-reported). */
export function findingSource(origin: string | null | undefined): string {
  if (origin === 'first_party_observed') return 'Airlock checker';
  if (origin === 'sandbox_self_reported') return 'Your tests';
  return 'Unknown';
}

export function cleanReason(reason: string): string {
  return reason.replace(/\s+[─━═]+\s*$/u, '');
}

/** The reasons that belong to one suite: lines the worker prefixed with "<suite>: ", without the prefix. */
export function reasonsForSuite(reasons: string[] | null | undefined, suite: string): string[] {
  const prefix = `${suite}: `;
  return (reasons ?? []).filter((r) => r.startsWith(prefix)).map((r) => r.slice(prefix.length));
}

/** The gate verdict in words. A default gate passes with warnings when only test suites failed; say so. */
export function gateVerdict(gate: { exitCode: number; reasons: string[] } | null, mode: string | null | undefined): string {
  if (!gate) return 'Not decided yet';
  if (gate.exitCode !== 0) return `Failed (exit ${gate.exitCode})`;
  const warned = gate.reasons.some((r) => r.startsWith('warning: '));
  if (!warned) return 'Passed';
  return mode === 'default' || !mode
    ? 'Passed with warnings: the default gate fails only on build and health-check failures'
    : 'Passed with warnings';
}

// ---------------------------------------------------------------------------
// Seal check. The server signs canonicalJson(seal) with Ed25519 (src/utils/crypto.ts). This is the same
// canonical form, and the check uses Web Crypto when the browser supports Ed25519.
// ---------------------------------------------------------------------------

/** Canonical JSON: keys sorted at every depth, no whitespace. Matches the server's canonicalJson. */
export function canonicalJson(value: unknown): string {
  const out = serialise(value, new Set());
  if (out === undefined) throw new TypeError('canonicalJson: value has no JSON representation');
  return out;
}

function serialise(value: unknown, seen: Set<object>): string | undefined {
  if (value !== null && typeof value === 'object' && typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    value = (value as { toJSON: () => unknown }).toJSON();
  }
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: non-finite number ${value}`);
      return JSON.stringify(value);
    case 'bigint':
      throw new TypeError('canonicalJson: BigInt is not supported');
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
  }
  const obj = value as object;
  if (seen.has(obj)) throw new TypeError('canonicalJson: circular reference');
  seen.add(obj);
  try {
    if (Array.isArray(obj)) return `[${obj.map((item) => serialise(item, seen) ?? 'null').join(',')}]`;
    const parts: string[] = [];
    for (const key of Object.keys(obj).sort()) {
      const item = serialise((obj as Record<string, unknown>)[key], seen);
      if (item !== undefined) parts.push(`${JSON.stringify(key)}:${item}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(obj);
  }
}

export interface SealCheck {
  /**
   * verified: the signature checks out in this browser. invalid: it does not match the seal.
   * unavailable: this browser cannot check Ed25519, so the signature is shown but NOT verified.
   * unsupported: the result is not an Ed25519 seal. missing: there is no sealed result.
   */
  state: 'verified' | 'invalid' | 'unavailable' | 'unsupported' | 'missing';
  keyId?: string;
}

function defaultSubtle(): SubtleCrypto | null {
  try {
    const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
    return subtle || null;
  } catch {
    return null;
  }
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem.replace(/-----BEGIN [^-]+-----/g, '').replace(/-----END [^-]+-----/g, '').replace(/\s+/g, '');
  return base64ToBytes(body);
}

/**
 * Checks the sealed result's Ed25519 signature over canonicalJson(seal) with the published public key.
 * Omit `subtle` to use the browser's Web Crypto; pass null to simulate a browser without it.
 */
export async function verifyQaSeal(evidence: unknown, subtle?: SubtleCrypto | null): Promise<SealCheck> {
  if (!evidence || typeof evidence !== 'object') return { state: 'missing' };
  const e = evidence as { algorithm?: unknown; seal?: unknown; signature?: unknown; publicKeyPem?: unknown; keyId?: unknown };
  const keyId = typeof e.keyId === 'string' ? e.keyId : undefined;
  if (typeof e.signature !== 'string' || typeof e.publicKeyPem !== 'string' || e.seal === undefined) {
    return { state: 'missing', keyId };
  }
  if (e.algorithm !== 'Ed25519') return { state: 'unsupported', keyId };
  const api = subtle === undefined ? defaultSubtle() : subtle;
  if (!api) return { state: 'unavailable', keyId };
  try {
    const key = await api.importKey('spki', pemToDer(e.publicKeyPem), { name: 'Ed25519' }, false, ['verify']);
    const data = new TextEncoder().encode(canonicalJson(e.seal));
    const ok = await api.verify({ name: 'Ed25519' }, key, base64ToBytes(e.signature), data);
    return { state: ok ? 'verified' : 'invalid', keyId };
  } catch {
    return { state: 'unavailable', keyId };
  }
}
