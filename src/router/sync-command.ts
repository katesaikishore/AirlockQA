import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { cloudRequest } from './cloud-api.js';
import { normalizeApiUrl } from './cloud-run-client.js';

export const SYNC_KINDS = ['trace', 'checkpoint', 'healing', 'fixtures', 'capsule'] as const;
export type SyncKind = (typeof SYNC_KINDS)[number];
const MAX_BYTES = 2 * 1024 * 1024;

export interface SyncArtifactInfo {
  id: string;
  kind: string;
  name: string;
  plaintextSize: number;
  storedSize: number;
  sha256: string;
  contentType: string;
  encrypted: boolean;
  createdAt: string;
}

export interface SyncTarget {
  apiUrl: string;
  apiKey: string;
}

export interface LocalArtifact {
  kind: SyncKind;
  name: string;
  file: string;
  size: number;
  contentType: string;
}

const DIRS: Array<{ kind: SyncKind; dir: string; recursive: boolean }> = [
  { kind: 'trace', dir: '.airlock/traces', recursive: false },
  { kind: 'checkpoint', dir: '.airlock/checkpoints', recursive: false },
  { kind: 'healing', dir: '.airlock/dataset', recursive: true },
  { kind: 'fixtures', dir: '.airlock/shadow', recursive: false },
  { kind: 'capsule', dir: '.airlock/capsules', recursive: false },
];

export function localArtifacts(cwd: string): LocalArtifact[] {
  const found: LocalArtifact[] = [];
  const walk = (kind: SyncKind, dir: string, recursive: boolean) => {
    const full = path.resolve(cwd, dir);
    let names: string[];
    try { names = fs.readdirSync(full); } catch { return; }
    for (const name of names.sort()) {
      const file = path.join(full, name);
      let stat: fs.Stats;
      try { stat = fs.lstatSync(file); } catch { continue; }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (recursive) {
          for (const nested of fs.readdirSync(file).sort()) {
            const child = path.join(file, nested);
            let childStat: fs.Stats;
            try { childStat = fs.lstatSync(child); } catch { continue; }
            if (childStat.isFile() && childStat.size <= MAX_BYTES) {
              found.push(toArtifact(kind, cwd, child, childStat.size));
            }
          }
        }
        continue;
      }
      if (stat.isFile() && stat.size <= MAX_BYTES) found.push(toArtifact(kind, cwd, file, stat.size));
    }
  };
  for (const entry of DIRS) walk(entry.kind, entry.dir, entry.recursive);
  return found;
}

function toArtifact(kind: SyncKind, cwd: string, file: string, size: number): LocalArtifact {
  const relative = path.relative(cwd, file).split(path.sep).join('/');
  const ext = path.extname(file).toLowerCase();
  return {
    kind,
    name: relative.slice(0, 160),
    file,
    size,
    contentType: ext === '.json' ? 'application/json' : ext === '.jsonl' ? 'application/x-ndjson' : 'application/octet-stream',
  };
}

/** AES-256-GCM with a scrypt key. The key never leaves this process; the server gets an opaque envelope. */
export function encryptArtifact(plaintext: Buffer, passphrase: string): Buffer {
  if (passphrase.length < 12) throw new Error('AIRLOCK_SYNC_KEY must be at least 12 characters');
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.from(JSON.stringify({
    v: 1,
    alg: 'aes-256-gcm',
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: data.toString('base64'),
  }));
}

export function decryptArtifact(envelope: Buffer, passphrase: string): Buffer {
  const parsed = JSON.parse(envelope.toString('utf8')) as {
    v?: unknown; alg?: unknown; kdf?: unknown; salt?: unknown; iv?: unknown; tag?: unknown; data?: unknown;
  };
  if (parsed.v !== 1 || parsed.alg !== 'aes-256-gcm' || parsed.kdf !== 'scrypt') throw new Error('unsupported sync envelope');
  const salt = Buffer.from(String(parsed.salt), 'base64');
  const iv = Buffer.from(String(parsed.iv), 'base64');
  const tag = Buffer.from(String(parsed.tag), 'base64');
  const data = Buffer.from(String(parsed.data), 'base64');
  const key = crypto.scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

export function syncKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const key = env.AIRLOCK_SYNC_KEY;
  if (!key || key.trim().length < 12) {
    throw new Error('Set AIRLOCK_SYNC_KEY to a passphrase of at least 12 characters. The key stays on this machine; the server stores only ciphertext.');
  }
  return key;
}

export async function uploadLocalArtifacts(
  target: SyncTarget,
  cwd: string,
  key: string,
  kinds: SyncKind[],
  options: { dryRun?: boolean; log?: (line: string) => void } = {}
): Promise<{ uploaded: number; skipped: number; artifacts: SyncArtifactInfo[] }> {
  const log = options.log ?? ((line: string) => process.stdout.write(line + '\n'));
  const all = localArtifacts(cwd).filter((artifact) => kinds.includes(artifact.kind));
  let uploaded = 0;
  let skipped = 0;
  const artifacts: SyncArtifactInfo[] = [];
  for (const artifact of all) {
    if (artifact.size > MAX_BYTES) { skipped++; log(`skip ${artifact.name}: larger than 2 MB`); continue; }
    if (options.dryRun) { log(`would upload ${artifact.kind} ${artifact.name} (${artifact.size} bytes)`); continue; }
    const plaintext = fs.readFileSync(artifact.file);
    const payload = encryptArtifact(plaintext, key);
    const body = {
      kind: artifact.kind,
      name: artifact.name,
      contentType: artifact.contentType,
      plaintextSize: plaintext.length,
      sha256: crypto.createHash('sha256').update(plaintext).digest('hex'),
      payloadBase64: payload.toString('base64'),
      encrypted: true as const,
    };
    const response = await cloudRequest<{ artifact: SyncArtifactInfo }>(target, 'POST', '/v1/sync/artifacts', body);
    artifacts.push(response.artifact);
    uploaded++;
    log(`uploaded ${response.artifact.kind} ${response.artifact.name} (${response.artifact.plaintextSize} bytes)`);
  }
  return { uploaded, skipped, artifacts };
}

export async function listSyncArtifacts(target: SyncTarget, limit = 50): Promise<SyncArtifactInfo[]> {
  const response = await cloudRequest<{ artifacts: SyncArtifactInfo[] }>(target, 'GET', `/v1/sync/artifacts?limit=${limit}`);
  return response.artifacts;
}

export async function downloadSyncArtifact(target: SyncTarget, id: string, key: string, out: string): Promise<void> {
  if (!/^sync_[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error('invalid sync artifact id');
  const base = normalizeApiUrl(target.apiUrl);
  const response = await fetch(`${base}/v1/sync/artifacts/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${target.apiKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`download failed (HTTP ${response.status})`);
  const envelope = Buffer.from(await response.arrayBuffer());
  const plaintext = decryptArtifact(envelope, key);
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, plaintext, { mode: 0o600 });
  process.stdout.write(`wrote ${out} (${plaintext.length} bytes)\n`);
}
