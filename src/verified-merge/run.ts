/**
 * Execute Playwright for Verified Merge in the customer's checkout.
 *
 * The command is operator-supplied (CI config), the specs come from git-tracked files selected by the
 * diff, and every argument is shell-escaped. The JSON reporter writes to a private temp file via
 * PLAYWRIGHT_JSON_OUTPUT_NAME so the process's own stdout cannot corrupt the report.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface PlaywrightRunOptions {
  cwd: string;
  specs: string[];
  /** Defaults to `npx playwright test {specs}`. `{specs}` is replaced with shell-escaped spec paths. */
  command?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  label?: string;
}

export interface PlaywrightRunResult {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  reportPath: string;
  stdoutTail: string;
  stderrTail: string;
  command: string;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function tail(text: string, lines = 40): string {
  return String(text || '').split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');
}

export async function runPlaywright(options: PlaywrightRunOptions): Promise<PlaywrightRunResult> {
  if (!options.cwd || !fs.existsSync(options.cwd)) throw new Error(`Playwright cwd not found: ${options.cwd}`);
  if (!options.specs.length) throw new Error('Verified Merge found no affected specs to run');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airlock-vm-run-'));
  const reportPath = path.join(dir, 'playwright-results.json');
  const template = options.command || 'npx playwright test {specs} --reporter=json';
  const escaped = options.specs.map(shellQuote).join(' ');
  const command = template.includes('{specs}') ? template.replace(/\{specs\}/g, escaped) : `${template} ${escaped}`;
  const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 15 * 60_000;
  const started = Date.now();
  const result = await new Promise<{ code: number | null; timedOut: boolean; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(command, {
      cwd: options.cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(options.env || {}), PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath },
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
      resolve({ code: null, timedOut: false, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, stdout, stderr });
    });
  });
  if (!fs.existsSync(reportPath)) {
    throw new Error(`Playwright did not write a JSON report. Command: ${command}\n${tail(result.stderr) || tail(result.stdout)}`);
  }
  return {
    exitCode: result.code,
    timedOut: result.timedOut,
    durationMs: Date.now() - started,
    reportPath,
    stdoutTail: tail(result.stdout),
    stderrTail: tail(result.stderr),
    command,
  };
}

/** Spec files that failed in a Playwright JSON report, for the deterministic rerun. */
export function failedSpecFiles(run: { tests: Array<{ file: string; status: string }> }): string[] {
  return Array.from(new Set(run.tests.filter((test) => ['failed', 'timedOut', 'interrupted'].includes(test.status)).map((test) => test.file))).sort();
}
