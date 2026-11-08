import type { CreateQaRunBody } from '../../cloud/shared/contract.js';
import { cloudRequest } from './cloud-api.js';
import { normalizeApiUrl } from './cloud-run-client.js';
import { canonicalJson, verifyEd25519 } from '../utils/crypto.js';
import { buildQaRunRequest, QaPreflightError, type BuildQaRunInput } from './qa-preflight.js';

export interface QaCliDeps {
  readRemote: () => Promise<string>;
  readHead: () => Promise<string>;
  readBranch: () => Promise<string>;
  isDirty: () => Promise<boolean>;
  isPushed: BuildQaRunInput['isPushed'];
  readConfig: () => Promise<{ qa?: { scripts?: Record<string, string>; port?: number; healthPath?: string } }>;
}

export interface QaCliOptions {
  suites: string[];
  gate: 'strict' | 'default';
  continueOnFailure?: boolean;
  /** CI overrides: the repository/commit to test instead of the checkout's origin and HEAD. */
  repo?: string;
  sha?: string;
  branch?: string;
}

/** Accept both owner/repo and a full public GitHub URL for the CLI override. */
export function normalizeGithubRepo(input: string): string {
  const value = input.trim().replace(/\.git$/, '');
  if (/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(value)) {
    return `https://github.com/${value}`;
  }
  return value;
}

export type DryRunResult =
  | { ok: true; body: CreateQaRunBody; warnings: string[] }
  | { ok: false; message: string };

/** `airlock qa --dry-run`: prepare and check the request, print it, submit nothing. */
export async function prepareQaDryRun(opts: QaCliOptions, deps: QaCliDeps): Promise<DryRunResult> {
  try {
    const [remoteUrl, sha, branch, dirty, config] = await Promise.all([
      opts.repo ? Promise.resolve(normalizeGithubRepo(opts.repo)) : deps.readRemote(),
      opts.sha ? Promise.resolve(opts.sha.trim()) : deps.readHead(),
      opts.branch ? Promise.resolve(opts.branch.trim()) : deps.readBranch(),
      deps.isDirty().catch(() => false),
      deps.readConfig(),
    ]);
    const { body, warnings } = await buildQaRunRequest({
      remoteUrl,
      sha,
      branch,
      config,
      suites: opts.suites,
      gate: opts.gate,
      continueOnFailure: opts.continueOnFailure === true,
      dirty,
      isPushed: deps.isPushed,
    });
    return { ok: true, body, warnings };
  } catch (err) {
    if (err instanceof QaPreflightError) return { ok: false, message: err.message };
    throw err;
  }
}

/** Real dependencies: git and the GitHub CLI, each run with argument arrays (no shell). */
export function realQaDeps(cwd: string = process.cwd()): QaCliDeps {
  const { execFile } = require('node:child_process') as typeof import('node:child_process');
  const { readFile } = require('node:fs/promises') as typeof import('node:fs/promises');
  const run = (cmd: string, args: string[]) =>
    new Promise<string>((resolve, reject) =>
      execFile(cmd, args, { cwd, timeout: 20_000, maxBuffer: 1 << 20 }, (err, stdout) =>
        err ? reject(new QaPreflightError(`${cmd} ${args[0] ?? ''} failed: ${err.message.split('\n')[0]}`)) : resolve(stdout.trim())
      )
    );
  return {
    readRemote: () => run('git', ['remote', 'get-url', 'origin']),
    readHead: () => run('git', ['rev-parse', 'HEAD']),
    readBranch: () => run('git', ['rev-parse', '--abbrev-ref', 'HEAD']),
    isDirty: async () => (await run('git', ['status', '--porcelain'])).length > 0,
    isPushed: async (sha, repo) => {
      const slug = repo.replace('https://github.com/', '');
      try {
        await run('gh', ['api', `repos/${slug}/commits/${sha}`, '--silent']);
        return true;
      } catch {
        return false;
      }
    },
    readConfig: async () => {
      try {
        return JSON.parse(await readFile(`${cwd}/airlock.config.json`, 'utf8'));
      } catch {
        return {};
      }
    },
  };
}

export interface QaTarget {
  apiUrl: string;
  apiKey: string;
  fetcher?: typeof fetch;
}

export interface QaArtifactInfo {
  name: string;
  size: number;
  sha256: string;
  contentType: string;
  route: string | null;
  note: string | null;
  createdAt: string;
}

export interface QaRunDetail {
  id: string;
  status: string;
  phase: string | null;
  repo?: string | null;
  sha?: string | null;
  branch?: string | null;
  createdAt?: string | null;
  finishedAt?: string | null;
  suites: Array<{ suite: string; status: string }>;
  gate: { exitCode: number; reasons: string[]; continueOnFailure?: boolean } | null;
  gateMode?: string | null;
  failureReason?: string | null;
  error?: string | null;
  findings?: Array<{ klass: string; severity: string; origin: string; route: string; assertion: string; fingerprint?: string }>;
  artifacts?: QaArtifactInfo[];
  evidence?: unknown;
}

const TERMINAL_QA = new Set(['SUCCESS', 'FAILED', 'CANCELLED']);

/** Submit a prepared request. Returns the run id; nothing is run until the stage worker claims it. */
export async function submitQaRun(body: unknown, target: QaTarget): Promise<{ id: string; status: string }> {
  return cloudRequest<{ id: string; status: string }>(target, 'POST', '/v1/qa-runs', body);
}

/** Poll until the run is terminal. Times out with an explicit message rather than reporting a guess. */
export async function waitForQaRun(
  target: QaTarget,
  id: string,
  opts: { intervalMs?: number; timeoutMs?: number } = {}
): Promise<QaRunDetail> {
  const intervalMs = opts.intervalMs ?? 15_000;
  const deadline = Date.now() + (opts.timeoutMs ?? 60 * 60_000);
  for (;;) {
    const run = await cloudRequest<QaRunDetail>(target, 'GET', `/v1/qa-runs/${encodeURIComponent(id)}`);
    if (TERMINAL_QA.has(run.status)) return run;
    if (Date.now() >= deadline) throw new QaPreflightError(`QA run ${id} did not finish in time (last status ${run.status})`);
    if (intervalMs > 0) await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Fetch one QA run (used by the report command; waitForQaRun already polls this route). */
export function getQaRun(target: QaTarget, id: string): Promise<QaRunDetail> {
  return cloudRequest<QaRunDetail>(target, 'GET', `/v1/qa-runs/${encodeURIComponent(id)}`);
}

/** Screenshot metadata for a finished (or running) QA run. */
export async function listQaArtifacts(target: QaTarget, id: string): Promise<QaArtifactInfo[]> {
  const res = await cloudRequest<{ artifacts?: QaArtifactInfo[] }>(target, 'GET', `/v1/qa-runs/${encodeURIComponent(id)}/artifacts`);
  return res.artifacts ?? [];
}

/** Download one screenshot. Binary route: JSON helpers cannot carry it, so this fetches the bytes directly. */
export async function downloadQaArtifact(
  target: QaTarget,
  id: string,
  name: string
): Promise<{ bytes: Uint8Array; contentType: string }> {
  if (!/^screenshot-[1-9][0-9]?\.(jpg|png)$/.test(name)) throw new Error(`invalid screenshot name: ${name}`);
  const base = normalizeApiUrl(target.apiUrl);
  const fetcher = target.fetcher ?? fetch;
  const res = await fetcher(`${base}/v1/qa-runs/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(name)}`, {
    headers: { Authorization: `Bearer ${target.apiKey}`, Accept: 'image/jpeg,image/png' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`screenshot ${name} download failed (HTTP ${res.status})`);
  return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get('content-type') ?? 'application/octet-stream' };
}

/** Check the service's signature over a sealed QA result, with the key the service published with that result. */
export function verifyQaSeal(evidence: unknown): boolean {
  if (!evidence || typeof evidence !== 'object') return false;
  const e = evidence as { algorithm?: unknown; seal?: unknown; signature?: unknown; publicKeyPem?: unknown };
  if (e.algorithm !== 'Ed25519' || typeof e.signature !== 'string' || typeof e.publicKeyPem !== 'string' || e.seal === undefined) return false;
  return verifyEd25519(canonicalJson(e.seal), e.signature, e.publicKeyPem);
}
