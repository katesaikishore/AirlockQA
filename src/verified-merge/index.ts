/**
 * Verified Merge: triage the Playwright specs a PR affects, report only failures that reproduce,
 * and sign the verdict so CI can attach it to the pull request.
 *
 * This module is pure apart from reading git/report files in the helper functions. Execution of the
 * customer's suite is the caller's job (CI or `qafind verify-merge --run`); triage never invents a result.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { isJUnitReport, parseJUnitReport } from './junit.js';
export { isJUnitReport, parseJUnitReport } from './junit.js';
import * as path from 'node:path';
import { diffFromGit, isSourceFile, isTestFile, parseUnifiedDiff } from './diff.js';
import { resolveSigningKey, type SigningAlgorithm } from '../compliance/attestation.js';
import type { InTotoStatement } from '../compliance/intoto.js';
import { canonicalJson, ed25519KeyId, ed25519PublicKeyPem, sha256, signEd25519, signHmac, verifyEd25519, verifyHmac } from '../utils/crypto.js';

export const VERIFIED_MERGE_VERSION = 1 as const;
export const VERIFIED_MERGE_KIND = 'qafind-verified-merge' as const;

export type MergeTestStatus = 'passed' | 'failed' | 'skipped' | 'timedOut' | 'interrupted';
export type TriageStatus = 'regression' | 'flake' | 'unreproduced' | 'not_rerun';

export interface PlaywrightTestRecord {
  file: string;
  title: string;
  titlePath: string[];
  project: string;
  status: MergeTestStatus;
  /** One record per retry attempt, in order. */
  attempts: Array<{ status: MergeTestStatus; durationMs: number; error: string }>;
}

export interface PlaywrightRun {
  file: string;
  tests: PlaywrightTestRecord[];
  stats: { expected: number; unexpected: number; flaky: number; skipped: number; durationMs: number };
}

export interface TestVerdict {
  id: string;
  file: string;
  title: string;
  status: TriageStatus;
  firstStatus: MergeTestStatus;
  attempts: number;
  rerunStatuses: MergeTestStatus[];
  error: string;
  reproduction: 'all-failed' | 'passed-on-rerun' | 'not-rerun';
}

export interface VerifiedMergeVerdict {
  version: typeof VERIFIED_MERGE_VERSION;
  kind: typeof VERIFIED_MERGE_KIND;
  generatedAt: string;
  repo: string | null;
  prNumber: number | null;
  baseSha: string | null;
  headSha: string | null;
  affectedSpecs: string[];
  selection: 'changed-tests' | 'changed-tests-and-references' | 'all-tests' | 'explicit';
  summary: {
    specs: number;
    tests: number;
    passed: number;
    failed: number;
    regressions: number;
    flakes: number;
    unreproduced: number;
    notRerun: number;
  };
  verdicts: TestVerdict[];
  /** Only reproduced regressions are allowed to block a merge. */
  blockMerge: boolean;
}

export interface PlaywrightReportJson {
  suites?: unknown[];
  stats?: Record<string, unknown>;
  errors?: unknown[];
}

function isFailed(status: MergeTestStatus): boolean {
  return status === 'failed' || status === 'timedOut' || status === 'interrupted';
}

function cleanError(text: unknown, max = 800): string {
  const value = String(text ?? '')
    .replace(/sk-[A-Za-z0-9]{10,}/g, 'sk-<redacted>')
    .replace(/air_live_[A-Za-z0-9]{8,}/g, 'air_live_<redacted>');
  return value.length > max ? value.slice(0, max) : value;
}

function firstError(results: unknown[]): string {
  for (const result of results) {
    const error = (result as { error?: { message?: string } })?.error?.message;
    if (error) return cleanError(error);
  }
  return '';
}

function flattenSuites(suites: unknown[], out: PlaywrightTestRecord[]): void {
  for (const suite of suites) {
    const value = suite as { title?: string; file?: string; specs?: unknown[]; suites?: unknown[] };
    const file = String(value.file || '');
    for (const spec of value.specs || []) {
      const record = spec as { title?: string; file?: string; tests?: unknown[] };
      const tests = record.tests || [];
      for (const test of tests) {
        const item = test as { status?: string; projectName?: string; results?: unknown[] };
        const results = (item.results || []) as Array<{ status?: string; duration?: number; error?: { message?: string } }>;
        const top = String(item.status || '');
        const last = results[results.length - 1]?.status;
        // Playwright reports the *spec* outcome as expected/unexpected/flaky while each attempt carries
        // the real status. Normalize to the last attempt so triage reasons about what actually happened.
        const status = (top === 'skipped' ? 'skipped' : last || (top === 'unexpected' ? 'failed' : top) || 'failed') as MergeTestStatus;
        out.push({
          file: String(record.file || file),
          title: String(record.title || value.title || ''),
          titlePath: [String(value.title || ''), String(record.title || '')].filter(Boolean),
          project: String(item.projectName || ''),
          status,
          attempts: results.map((result) => ({
            status: String(result.status || 'failed') as MergeTestStatus,
            durationMs: Number(result.duration || 0),
            error: cleanError(result.error?.message),
          })),
        });
      }
    }
    flattenSuites(value.suites || [], out);
  }
}

export function parsePlaywrightReport(file: string): PlaywrightRun {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as PlaywrightReportJson;
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.suites)) throw new Error('Not a Playwright JSON report (missing suites)');
  const tests: PlaywrightTestRecord[] = [];
  flattenSuites(raw.suites, tests);
  const stats = raw.stats || {};
  return {
    file,
    tests,
    stats: {
      expected: Number(stats.expected || 0),
      unexpected: Number(stats.unexpected || 0),
      flaky: Number(stats.flaky || 0),
      skipped: Number(stats.skipped || 0),
      durationMs: Number(stats.duration || 0),
    },
  };
}

function testId(record: PlaywrightTestRecord): string {
  return `${record.file}::${record.title}`;
}

function git(cwd: string, args: string[]): string {
  try {
    return String(execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }) || '').trim();
  } catch {
    return '';
  }
}

export function allTestFiles(cwd: string): string[] {
  return git(cwd, ['ls-files']).split('\n').filter((file) => file && isTestFile(file));
}

/** Pick the specs a diff touches: changed tests, plus tests that reference a changed source basename. */
export function affectedSpecs(cwd: string, base: string, head: string): { specs: string[]; selection: VerifiedMergeVerdict['selection']; files: ReturnType<typeof parseUnifiedDiff> } {
  const diff = diffFromGit(base, head, cwd);
  const files = parseUnifiedDiff(diff);
  const tests = allTestFiles(cwd);
  const changedTests = files.filter((file) => isTestFile(file.path)).map((file) => file.path);
  const changedSources = files.filter((file) => isSourceFile(file.path));
  const referenced = new Set<string>();
  for (const source of changedSources) {
    const stem = path.basename(source.path).replace(/\.[^.]+$/, '');
    if (stem.length < 3) continue;
    for (const testFile of tests) {
      try {
        if (fs.readFileSync(path.join(cwd, testFile), 'utf8').includes(stem)) referenced.add(testFile);
      } catch { /* unreadable files are not selected */ }
    }
  }
  const selected = Array.from(new Set([...changedTests, ...referenced])).sort();
  if (selected.length) {
    return {
      specs: selected,
      selection: changedTests.length && referenced.size ? 'changed-tests-and-references' : changedTests.length ? 'changed-tests' : 'changed-tests-and-references',
      files,
    };
  }
  // A source-only change with no discoverable reference still needs verification; run a bounded set.
  if (changedSources.length) return { specs: tests.slice(0, 50), selection: 'all-tests', files };
  return { specs: [], selection: 'explicit', files };
}

/** Triaging two runs of the same specs: failures that pass on rerun are flakes, never reported regressions. */
export function triageRuns(first: PlaywrightRun, rerun: PlaywrightRun | null): TestVerdict[] {
  const rerunById = new Map((rerun?.tests || []).map((test) => [testId(test), test]));
  const verdicts: TestVerdict[] = [];
  for (const test of first.tests) {
    if (!isFailed(test.status)) continue;
    const second = rerunById.get(testId(test));
    const rerunStatuses = second ? second.attempts.map((attempt) => attempt.status) : [];
    const hasPass = rerunStatuses.includes('passed');
    const allFailed = rerunStatuses.length > 0 && rerunStatuses.every((status) => status !== 'passed');
    const status: TriageStatus = !second ? 'not_rerun' : hasPass ? 'flake' : allFailed ? 'regression' : 'unreproduced';
    verdicts.push({
      id: testId(test),
      file: test.file,
      title: test.title,
      status,
      firstStatus: test.status,
      attempts: test.attempts.length,
      rerunStatuses,
      error: test.attempts.find((attempt) => attempt.error)?.error || '',
      reproduction: !second ? 'not-rerun' : hasPass ? 'passed-on-rerun' : allFailed ? 'all-failed' : 'not-rerun',
    });
  }
  return verdicts;
}

export interface BuildVerdictOptions {
  repo?: string | null;
  prNumber?: number | null;
  baseSha?: string | null;
  headSha?: string | null;
  specs: string[];
  selection: VerifiedMergeVerdict['selection'];
  first: PlaywrightRun;
  rerun: PlaywrightRun | null;
  failingOnBase?: 'known_flake' | 'unknown';
}

export function buildVerdict(options: BuildVerdictOptions): VerifiedMergeVerdict {
  const verdicts = triageRuns(options.first, options.rerun);
  if (options.failingOnBase === 'known_flake') {
    for (const verdict of verdicts) if (verdict.status === 'regression') verdict.status = 'flake';
  }
  const regressions = verdicts.filter((verdict) => verdict.status === 'regression').length;
  const flakes = verdicts.filter((verdict) => verdict.status === 'flake').length;
  return {
    version: VERIFIED_MERGE_VERSION,
    kind: VERIFIED_MERGE_KIND,
    generatedAt: new Date().toISOString(),
    repo: options.repo ?? null,
    prNumber: options.prNumber ?? null,
    baseSha: options.baseSha ?? null,
    headSha: options.headSha ?? null,
    affectedSpecs: options.specs,
    selection: options.selection,
    summary: {
      specs: options.specs.length,
      tests: options.first.tests.length,
      passed: options.first.tests.filter((test) => test.status === 'passed').length,
      failed: options.first.tests.filter((test) => isFailed(test.status)).length,
      regressions,
      flakes,
      unreproduced: verdicts.filter((verdict) => verdict.status === 'unreproduced').length,
      notRerun: verdicts.filter((verdict) => verdict.status === 'not_rerun').length,
    },
    verdicts,
    blockMerge: regressions > 0,
  };
}

export interface SignedVerdict {
  version: typeof VERIFIED_MERGE_VERSION;
  kind: typeof VERIFIED_MERGE_KIND;
  payload: VerifiedMergeVerdict;
  payloadSha256: string;
  signature: { algorithm: SigningAlgorithm; keyId: string; signature: string };
}

export function signVerdict(verdict: VerifiedMergeVerdict, options: { signingKey?: string; env?: Record<string, string | undefined> } = {}): SignedVerdict {
  const resolved = resolveSigningKey(options.signingKey, options.env || process.env);
  if (resolved.isDevKey) throw new Error('Refusing to sign a Verified Merge verdict with the development key; set QAFIND_SIGNING_KEY');
  const bytes = canonicalJson(verdict);
  const payloadSha256 = sha256(bytes);
  if (resolved.algorithm === 'Ed25519') {
    return {
      version: VERIFIED_MERGE_VERSION, kind: VERIFIED_MERGE_KIND, payload: verdict, payloadSha256,
      signature: { algorithm: 'Ed25519', keyId: ed25519KeyId(ed25519PublicKeyPem(resolved.key)), signature: signEd25519(bytes, resolved.key) },
    };
  }
  return {
    version: VERIFIED_MERGE_VERSION, kind: VERIFIED_MERGE_KIND, payload: verdict, payloadSha256,
    signature: { algorithm: 'HMAC-SHA256', keyId: `hmac:${sha256(resolved.key).slice(0, 16)}`, signature: signHmac(bytes, resolved.key) },
  };
}

export function renderVerdictMarkdown(verdict: VerifiedMergeVerdict): string {
  const lines: string[] = [];
  lines.push('## QAFind Verified Merge');
  lines.push('');
  lines.push(`**Verdict: ${verdict.blockMerge ? '❌ blocked — reproduced regression' : verdict.summary.flakes ? '✅ passed — flake-only failures' : '✅ passed'}**`);
  lines.push('');
  lines.push(`${verdict.summary.specs} affected specs · ${verdict.summary.tests} tests · ${verdict.summary.regressions} reproduced regressions · ${verdict.summary.flakes} flakes · ${verdict.summary.notRerun} not rerun`);
  if (verdict.verdicts.length) {
    lines.push('');
    lines.push('| Test | Status | Rerun |');
    lines.push('| --- | --- | --- |');
    for (const item of verdict.verdicts.slice(0, 30)) {
      const rerun = item.rerunStatuses.length ? item.rerunStatuses.join(', ') : 'not run';
      lines.push(`| \`${item.file} › ${item.title}\` | ${item.status} | ${rerun} |`);
    }
  }
  if (verdict.blockMerge) {
    lines.push('');
    lines.push('Only reproduced regressions are reported. A failure that passed on rerun is treated as a flake.');
  }
  return lines.join('\n') + '\n';
}

export function buildInTotoStatement(verdict: VerifiedMergeVerdict): InTotoStatement {
  return {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: verdict.repo || 'unknown', digest: { sha1: verdict.headSha || '' } }],
    predicateType: 'https://in-toto.io/attestation/test-result/v0.1',
    predicate: {
      result: verdict.blockMerge ? 'FAILED' : 'PASSED',
      configuration: { specs: verdict.affectedSpecs, selection: verdict.selection },
      tests: verdict.verdicts.map((item) => ({ name: `${item.file}::${item.title}`, result: item.status, rerun: item.rerunStatuses })),
      summary: verdict.summary,
      generatedAt: verdict.generatedAt,
    },
  };
}

export function loadReportIfExists(file: string | null | undefined): PlaywrightRun | null {
  if (!file) return null;
  if (!fs.existsSync(file)) throw new Error(`Test report not found: ${file}`);
  return isJUnitReport(file) ? parseJUnitReport(file) : parsePlaywrightReport(file);
}


export interface VerifySignedVerdictResult {
  valid: boolean;
  reason?: string;
  blockMerge: boolean;
  summary: VerifiedMergeVerdict['summary'] | null;
  verdict: VerifiedMergeVerdict | null;
}

/** Verify a signed Verified Merge verdict offline. HMAC uses the shared key; Ed25519 uses a public key. */
export function verifySignedVerdict(signed: unknown, options: { signingKey?: string; publicKeyPem?: string; env?: Record<string, string | undefined> } = {}): VerifySignedVerdictResult {
  try {
    const value = signed as Partial<SignedVerdict>;
    if (!value || value.version !== VERIFIED_MERGE_VERSION || value.kind !== VERIFIED_MERGE_KIND) return { valid: false, reason: 'not a QAFind Verified Merge verdict', blockMerge: false, summary: null, verdict: null };
    if (!value.payload || !value.signature) return { valid: false, reason: 'verdict payload or signature is missing', blockMerge: false, summary: null, verdict: null };
    const bytes = canonicalJson(value.payload);
    if (sha256(bytes) !== value.payloadSha256) return { valid: false, reason: 'payload hash does not match', blockMerge: false, summary: null, verdict: null };
    let valid = false;
    if (value.signature.algorithm === 'Ed25519') {
      const publicKey = options.publicKeyPem || (value.signature.keyId.startsWith('ed25519:') ? '' : '');
      if (!publicKey) return { valid: false, reason: 'Ed25519 verdict needs publicKeyPem', blockMerge: false, summary: null, verdict: null };
      valid = verifyEd25519(bytes, value.signature.signature, publicKey);
    } else {
      const resolved = resolveSigningKey(options.signingKey, options.env || process.env);
      valid = !resolved.isDevKey && resolved.algorithm === 'HMAC-SHA256' && verifyHmac(bytes, value.signature.signature, resolved.key);
    }
    return { valid, reason: valid ? undefined : 'signature verification failed', blockMerge: value.payload.blockMerge === true, summary: value.payload.summary, verdict: valid ? value.payload : null };
  } catch (error) {
    return { valid: false, reason: error instanceof Error ? error.message : String(error), blockMerge: false, summary: null, verdict: null };
  }
}
