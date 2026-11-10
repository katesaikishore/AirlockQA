import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { canFilePr, readVerificationEvidence, runVerification } from '../src/hunt/index.js';

function tempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qafind-verify-'));
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  return dir;
}

describe('hunt verification runner', () => {
  it('records a successful command with commit/cwd and machine-readable evidence', async () => {
    const dir = tempRepo();
    const evidence = await runVerification({ cwd: dir, command: 'bun -e "console.log(\'verified\')"', expect: 'success', timeoutMs: 10000 });
    expect(evidence.ok).toBe(true);
    expect(evidence.exitCode).toBe(0);
    expect(evidence.expect).toBe('success');
    expect(evidence.cwd).toBe(path.resolve(dir));
    expect(evidence.stdoutTail).toContain('verified');
    expect(fs.existsSync(evidence.artifactPath)).toBe(true);
    expect(fs.existsSync(evidence.logPath)).toBe(true);
    const loaded = readVerificationEvidence(evidence.artifactPath);
    expect(loaded.id).toBe(evidence.id);
    expect(loaded.kind).toBe('qafind-hunt-verification');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('supports expected-failure repro evidence', async () => {
    const dir = tempRepo();
    const evidence = await runVerification({ cwd: dir, command: 'bun -e "console.error(\'reproduced\'); process.exit(1)"', expect: 'failure', timeoutMs: 10000 });
    expect(evidence.ok).toBe(true);
    expect(evidence.exitCode).toBe(1);
    expect(evidence.stderrTail).toContain('reproduced');
    expect(evidence.timedOut).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('marks a timeout as not ok and records it', async () => {
    const dir = tempRepo();
    const evidence = await runVerification({ cwd: dir, command: 'bun -e "setTimeout(() => {}, 5000)"', expect: 'success', timeoutMs: 300 });
    expect(evidence.ok).toBe(false);
    expect(evidence.timedOut).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses an empty command and a missing cwd', async () => {
    await expect(runVerification({ cwd: process.cwd(), command: '   ' })).rejects.toThrow(/needs a command/);
    await expect(runVerification({ cwd: '/tmp/qafind-no-such-verify-dir', command: 'true' })).rejects.toThrow(/cwd not found/);
  });
});

describe('PR readiness gate', () => {
  const repro = { expect: 'failure' as const, ok: true, exitCode: 1 };
  const fix = { expect: 'success' as const, ok: true, exitCode: 0 };

  it('requires a clear dedupe gate plus failing repro and passing fix', () => {
    expect(canFilePr({ dedupe: 'CLEAR', repro: repro as never, fix: fix as never })).toEqual({ ready: true, reasons: [] });
    const blocked = canFilePr({ dedupe: 'BLOCK', repro: repro as never, fix: fix as never });
    expect(blocked.ready).toBe(false);
    expect(blocked.reasons[0]).toContain('BLOCK');
    const noRepro = canFilePr({ dedupe: 'CLEAR', fix: fix as never });
    expect(noRepro.ready).toBe(false);
    expect(noRepro.reasons.join(' ')).toContain('reproduction');
    const badFix = canFilePr({ dedupe: 'CLEAR', repro: repro as never, fix: { expect: 'success', ok: false, exitCode: 1 } as never });
    expect(badFix.ready).toBe(false);
    expect(badFix.reasons.join(' ')).toContain('fix');
  });

  it('rejects an artifact that claims success but has a non-zero exit code', () => {
    const result = canFilePr({ dedupe: 'CLEAR', repro: repro as never, fix: { expect: 'success', ok: true, exitCode: 1 } as never });
    expect(result.ready).toBe(false);
  });
});
