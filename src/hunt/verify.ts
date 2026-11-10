/**
 * Reproduce/verify runner for QA-hunt candidates.
 *
 * A static candidate is not PR-ready. This runner executes an explicit command in a repository,
 * records the commit, dirty state, exact command, exit code, timeout and logs, and writes a
 * verification artifact. Two artifacts make a repro:
 *   - `--expect failure` on the current commit (the bug reproduces), then
 *   - `--expect success` after the fix (with the added regression test).
 *
 * The command is supplied by the operator. Nothing is inferred and no shell text is composed from
 * candidate data, so a malicious candidate cannot choose what runs.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const HUNT_VERIFICATION_VERSION = 1 as const;

export type VerificationExpectation = 'success' | 'failure';

export interface VerificationEvidence {
  version: typeof HUNT_VERIFICATION_VERSION;
  kind: 'qafind-hunt-verification';
  id: string;
  command: string;
  cwd: string;
  commit: string;
  branch: string;
  dirty: boolean;
  expect: VerificationExpectation;
  ok: boolean;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  logPath: string;
  artifactPath: string;
  stdoutTail: string;
  stderrTail: string;
}

export interface VerificationOptions {
  cwd: string;
  command: string;
  expect?: VerificationExpectation;
  timeoutMs?: number;
  outputDir?: string;
  env?: Record<string, string>;
}

function git(cwd: string, args: string[]): string {
  try {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5000 });
    return result.status === 0 ? String(result.stdout || '').trim() : '';
  } catch {
    return '';
  }
}

function redact(text: string): string {
  return String(text || '')
    .replace(/sk-[A-Za-z0-9]{10,}/g, 'sk-<redacted>')
    .replace(/air_live_[A-Za-z0-9]{8,}/g, 'air_live_<redacted>')
    .replace(/(authorization|api[_-]?key)\s*[:=]\s*\S+/gi, '$1=<redacted>');
}

function tail(text: string, lines = 60): string {
  const all = String(text || '')
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
  return redact(all.slice(-lines).join('\n'));
}

/** Execute exactly one command and write a verification artifact. Never throws on command failure. */
export async function runVerification(options: VerificationOptions): Promise<VerificationEvidence> {
  if (!options || typeof options.command !== 'string' || options.command.trim() === '') {
    throw new Error('verify needs a command');
  }
  const cwd = path.resolve(options.cwd || process.cwd());
  if (!fs.existsSync(cwd)) throw new Error(`Verification cwd not found: ${cwd}`);
  const expect: VerificationExpectation = options.expect === 'failure' ? 'failure' : 'success';
  const timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs as number) > 0 ? (options.timeoutMs as number) : 120_000;
  const started = new Date();
  const startedAt = new Date().toISOString();
  const id = `hv-${startedAt.replace(/[^0-9]/g, '').slice(0, 14)}-${createHash('sha256').update(options.command + cwd).digest('hex').slice(0, 8)}`;
  const outputDir = path.resolve(cwd, options.outputDir || '.qafind/hunt/verifications');
  const artifactPath = path.join(outputDir, `${id}.json`);
  const logPath = path.join(outputDir, `${id}.log`);
  fs.mkdirSync(outputDir, { recursive: true });

  const startedAtMs = Date.now();
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(options.command, {
      cwd,
      shell: true,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const cap = 2 * 1024 * 1024;
    const append = (current: string, chunk: Buffer): string => (current.length >= cap ? current : current + chunk.toString('utf8'));
    child.stdout?.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-(child.pid as number), 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, timedOut: false, stdout, stderr: stderr + '\n' + error.message });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, stdout, stderr });
    });
  });

  const finished = new Date();
  const durationMs = finished.getTime() - startedAtMs;
  const success = !result.timedOut && result.code === 0;
  const ok = expect === 'failure' ? !success : success;
  const evidence: VerificationEvidence = {
    version: HUNT_VERIFICATION_VERSION,
    kind: 'qafind-hunt-verification',
    id,
    command: redact(options.command),
    cwd,
    commit: git(cwd, ['rev-parse', 'HEAD']),
    branch: git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    dirty: git(cwd, ['status', '--porcelain']).length > 0,
    expect,
    ok,
    exitCode: result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    durationMs,
    startedAt,
    finishedAt: finished.toISOString(),
    logPath,
    artifactPath,
    stdoutTail: tail(result.stdout),
    stderrTail: tail(result.stderr),
  };
  fs.writeFileSync(logPath, `$ ${options.command}\n\n--- stdout ---\n${redact(result.stdout)}\n\n--- stderr ---\n${redact(result.stderr)}\n`);
  fs.writeFileSync(artifactPath, JSON.stringify(evidence, null, 2) + '\n');
  return evidence;
}

export function readVerificationEvidence(file: string): VerificationEvidence {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object') throw new Error('Not a verification artifact');
  const value = parsed as VerificationEvidence;
  if (value.version !== HUNT_VERIFICATION_VERSION || value.kind !== 'qafind-hunt-verification') {
    throw new Error('Not an QAFind hunt verification artifact');
  }
  return value;
}

/** A PR is evidence-gated: dedupe CLEAR plus a failing repro and a passing fix. */
export function canFilePr(input: {
  dedupe: 'BLOCK' | 'REVIEW' | 'CLEAR';
  repro?: VerificationEvidence;
  fix?: VerificationEvidence;
}): { ready: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (input.dedupe !== 'CLEAR') reasons.push(`duplicate gate is ${input.dedupe}`);
  if (!input.repro) reasons.push('no failing reproduction artifact (run verify --expect failure)');
  else if (!input.repro.ok || input.repro.expect !== 'failure' || input.repro.exitCode === 0) reasons.push('reproduction artifact does not prove a failure');
  if (!input.fix) reasons.push('no passing fix artifact (run verify --expect success)');
  else if (!input.fix.ok || input.fix.expect !== 'success' || input.fix.exitCode !== 0) reasons.push('fix artifact does not prove success');
  return { ready: reasons.length === 0, reasons };
}
