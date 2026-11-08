import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { decryptArtifact, encryptArtifact, localArtifacts, syncKeyFromEnv } from '../src/router/sync-command.ts';

const dirs: string[] = [];
function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airlock-sync-cli-'));
  dirs.push(dir);
  return dir;
}
afterAll(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });

describe('local sync: encryption', () => {
  test('AES-256-GCM round-trips and a wrong key fails closed', () => {
    const plaintext = Buffer.from('{"trace":"checkout","secret":"do-not-leak"}');
    const envelope = encryptArtifact(plaintext, 'a long enough passphrase');
    expect(envelope.toString('utf8')).not.toContain('do-not-leak');
    expect(decryptArtifact(envelope, 'a long enough passphrase')).toEqual(plaintext);
    expect(() => decryptArtifact(envelope, 'a different passphrase')).toThrow();
  });

  test('requires a key of at least 12 characters', () => {
    expect(() => encryptArtifact(Buffer.from('x'), 'short')).toThrow(/at least 12/);
    expect(() => syncKeyFromEnv({})).toThrow(/AIRLOCK_SYNC_KEY/);
    expect(syncKeyFromEnv({ AIRLOCK_SYNC_KEY: 'long-enough-key' })).toBe('long-enough-key');
  });
});

describe('local sync: file discovery', () => {
  test('finds traces, checkpoints, healing files, fixtures and capsules under .airlock', () => {
    const cwd = temp();
    const write = (relative: string, body = '{}') => {
      const file = path.join(cwd, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
    };
    write('.airlock/traces/checkout.json');
    write('.airlock/checkpoints/paid.json');
    write('.airlock/dataset/healing/2026-11-08.jsonl', '{"healed":true}\n');
    write('.airlock/shadow/wire-catalog.json');
    write('.airlock/capsules/cap_1.json');
    const artifacts = localArtifacts(cwd);
    expect(artifacts.map((a) => `${a.kind}:${a.name}`).sort()).toEqual([
      'capsule:.airlock/capsules/cap_1.json',
      'checkpoint:.airlock/checkpoints/paid.json',
      'fixtures:.airlock/shadow/wire-catalog.json',
      'healing:.airlock/dataset/healing/2026-11-08.jsonl',
      'trace:.airlock/traces/checkout.json',
    ]);
    expect(artifacts.find((a) => a.kind === 'healing')?.contentType).toBe('application/x-ndjson');
  });
});
