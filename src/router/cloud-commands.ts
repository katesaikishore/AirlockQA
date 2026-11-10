import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RunDetail, RunSummary } from '../../cloud/shared/contract.js';
import { checkUrlSyntax, TargetBlockedError } from '../../cloud/shared/url-guard.js';
import { AttestationEngine } from '../compliance/attestation.js';
import { loadConfig } from '../config/loader.js';
import { loadWorkflow } from '../config/workflow-schema.js';
import type { ComplianceProofBundle } from '../types/index.js';
import { ensureDir, writeJsonFile } from '../utils/files.js';
import { safeFileName, safeText } from '../utils/safe-text.js';
import { logger } from '../utils/logger.js';
import {
  type ApiTarget,
  getEvidenceKey,
  getRun,
  getRunEvidence,
  getUsage,
  listRuns,
  waitForRun,
} from './cloud-api.js';
import {
  type CloudAuth,
  DEFAULT_CLOUD_URL,
  clearCredentials,
  credentialsPath,
  keyPrefix,
  looksLikeApiKey,
  resolveCloudAuth,
  saveCredentials,
} from './cloud-credentials.js';
import { createCloudRunPayload, submitCloudRun } from './cloud-run-client.js';

const out = (line = '') => console.log(line);

function requireAuth(options: { apiKey?: string; apiUrl?: string } = {}): CloudAuth {
  const auth = resolveCloudAuth(options);
  if (!auth) {
    throw new Error('No QAFind Cloud key found. Run "qafind login", or set QAFIND_API_KEY. Create a key in the console under CI/CD & API.');
  }
  return auth;
}

const targetOf = (auth: CloudAuth): ApiTarget => ({ apiUrl: auth.apiUrl, apiKey: auth.apiKey });

function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '-';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function formatReset(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

async function readSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  return new Promise((resolve, reject) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const finish = (error?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(value.trim());
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u0003') return finish(new Error('Cancelled'));
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on('data', onData);
  });
}

// ---------------------------------------------------------------------------
// login / logout / whoami / usage
// ---------------------------------------------------------------------------

export async function loginCommand(options: { key?: string; apiUrl?: string } = {}): Promise<void> {
  const apiUrl = options.apiUrl?.trim() || process.env.QAFIND_CLOUD_URL?.trim() || DEFAULT_CLOUD_URL;
  let key = options.key?.trim() || process.env.QAFIND_API_KEY?.trim();
  if (!key) key = await readSecret('QAFind API key (input is hidden): ');
  if (!key || !looksLikeApiKey(key)) {
    throw new Error('That does not look like a QAFind API key (they start with "air_live_"). Create one in the console under CI/CD & API.');
  }

  const target: ApiTarget = { apiUrl, apiKey: key };
  const usage = await getUsage(target); // fails with a clear message for a wrong or revoked key
  let evidence: Awaited<ReturnType<typeof getEvidenceKey>> | undefined;
  try {
    evidence = await getEvidenceKey(target);
  } catch (error) {
    logger.warn(`Could not read the service's evidence key: ${error instanceof Error ? error.message : String(error)}`);
  }

  const file = saveCredentials({
    apiUrl,
    apiKey: key,
    evidenceKeyId: evidence?.keyId,
    evidencePublicKey: evidence?.publicKeyPem,
    savedAt: new Date().toISOString(),
  });
  logger.success(`Signed in to ${apiUrl}`);
  out(`  Key        ${keyPrefix(key)}`);
  out(`  Plan       ${usage.plan}, ${usage.daily.used} of ${usage.daily.limit} runs used today`);
  out(`  Saved to   ${file} (readable only by you)`);
  if (evidence) out(`  Evidence   pinned signing key ${evidence.keyId}`);
}

export function logoutCommand(): void {
  const removed = clearCredentials();
  if (removed) {
    logger.success('Removed the saved QAFind Cloud key from this machine.');
    out('The key itself stays valid until you revoke it in the console under CI/CD & API.');
  } else {
    logger.info(`No saved key at ${credentialsPath()}.`);
  }
  if (process.env.QAFIND_API_KEY) logger.warn('QAFIND_API_KEY is still set in your environment.');
}

export async function whoamiCommand(options: { apiUrl?: string } = {}): Promise<void> {
  const auth = requireAuth(options);
  const usage = await getUsage(targetOf(auth));
  const source = { option: 'a command option', env: 'QAFIND_API_KEY', stored: credentialsPath() }[auth.keySource];
  out(`API         ${auth.apiUrl}`);
  out(`Key         ${keyPrefix(auth.apiKey)} (from ${source})`);
  out(`Plan        ${usage.plan}`);
  out(`Runs today  ${usage.daily.used} of ${usage.daily.limit} (${usage.daily.remaining} left, resets ${formatReset(usage.daily.resetAt)})`);
}

export async function usageCommand(options: { json?: boolean; apiUrl?: string } = {}): Promise<void> {
  const auth = requireAuth(options);
  const usage = await getUsage(targetOf(auth));
  if (options.json) return out(JSON.stringify(usage, null, 2));
  const { daily, concurrent, limits } = usage;
  out(`Plan                 ${usage.plan}`);
  out(`Runs today           ${daily.used} of ${daily.limit} used, ${daily.remaining} left`);
  out(`Resets               ${formatReset(daily.resetAt)}`);
  out(`Running / queued     ${concurrent.running} / ${concurrent.queued} (limit ${concurrent.limit} at a time)`);
  out(`Limits per run       ${limits.maxSteps} steps, ${limits.runTimeoutSec} seconds`);
}

// ---------------------------------------------------------------------------
// runs
// ---------------------------------------------------------------------------

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width - 1) + ' ' : value.padEnd(width);
}

export function printRunDetail(run: RunDetail): void {
  out(`Run         ${safeText(run.runId, 80)}`);
  out(`Status      ${safeText(run.status, 40)}${run.failureReason ? ` (${safeText(run.failureReason, 40)})` : ''}`);
  out(`Suite       ${safeText(run.suiteName, 120)}`);
  out(`Target      ${safeText(run.targetUrl, 300)}`);
  out(`Started     ${safeText(run.startedAt ?? 'not started', 40)}`);
  out(`Duration    ${formatDuration(run.executionTimeMs)}`);
  out(`Steps       ${Number(run.passedSteps) || 0} passed, ${Number(run.failedSteps) || 0} failed, ${Number(run.totalSteps) || 0} total`);
  out(`Requests    ${Number(run.requestsAllowed) || 0} allowed, ${Number(run.requestsBlocked) || 0} blocked`);
  if (run.error) out(`Error       ${safeText(run.error, 500)}`);
  if (Array.isArray(run.steps) && run.steps.length) {
    out();
    for (const step of run.steps.slice(0, 200)) {
      const mark = step.ok ? 'ok    ' : 'FAILED';
      const where = step.target ? ` ${safeText(step.target, 200)}` : '';
      const extra = step.error ? `\n        ${safeText(step.error, 400)}` : step.detail ? ` (${safeText(step.detail, 200)})` : '';
      out(`  ${String((Number(step.index) || 0) + 1).padStart(2)}  ${mark}  ${safeText(step.action, 40)}${where}${extra}`);
    }
  }
}

/** Start the one-URL automatic cloud pipeline and optionally watch it. */
export async function appCommand(
  url: string,
  options: { apiKey?: string; apiUrl?: string; watch?: boolean; json?: boolean } = {},
): Promise<void> {
  const auth = requireAuth({ apiKey: options.apiKey, apiUrl: options.apiUrl });
  checkUrlSyntax(url);
  const base = auth.apiUrl.replace(/\/+$/, '');
  const headers = { authorization: `Bearer ${auth.apiKey}`, 'content-type': 'application/json' };
  const created = await fetch(`${base}/v1/applications`, { method: 'POST', headers, body: JSON.stringify({ targetUrl: url }) });
  const body = (await created.json().catch(() => ({}))) as { application?: Record<string, unknown>; message?: string };
  if (!created.ok) throw new Error(body.message || `QAFind Cloud returned ${created.status}`);
  const application = body.application ?? {};
  const id = String(application.id ?? '');
  if (options.json) out(JSON.stringify(application, null, 2));
  else {
    out(`Application  ${id}`);
    out(`Target       ${url}`);
    out(`Pipeline     ${String(application.pipelineStatus ?? 'QUEUED')}`);
  }
  if (!options.watch) return;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const response = await fetch(`${base}/v1/applications/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${auth.apiKey}` } });
    const detail = (await response.json().catch(() => ({}))) as { application?: Record<string, unknown>; message?: string };
    if (!response.ok) throw new Error(detail.message || `QAFind Cloud returned ${response.status}`);
    const app = detail.application ?? {};
    const status = String(app.pipelineStatus ?? 'UNKNOWN');
    if (options.json) out(JSON.stringify(app));
    else out(`Pipeline     ${status}${app.pipelineError ? ` — ${String(app.pipelineError)}` : ''}`);
    if (status === 'COMPLETE' || status === 'FAILED') return;
  }
}

export async function runsCommand(
  runId: string | undefined,
  options: { limit?: string; status?: string; json?: boolean; apiUrl?: string } = {}
): Promise<void> {
  const auth = requireAuth(options);
  const target = targetOf(auth);
  if (runId) {
    const run = await getRun(target, runId);
    return options.json ? out(JSON.stringify(run, null, 2)) : printRunDetail(run);
  }
  const limit = Math.min(100, Math.max(1, Number(options.limit) || 20));
  const { runs } = await listRuns(target, { limit, status: options.status?.toUpperCase() });
  if (options.json) return out(JSON.stringify(runs, null, 2));
  if (runs.length === 0) return out('No runs yet. Start one with "qafind test --cloud".');
  out(`${pad('RUN', 20)}${pad('STATUS', 18)}${pad('SUITE', 22)}${pad('STEPS', 8)}${pad('TIME', 10)}CREATED`);
  for (const run of runs as RunSummary[]) {
    out(
      `${pad(safeText(run.runId, 40), 20)}${pad(safeText(run.status, 30), 18)}${pad(safeText(run.suiteName, 60), 22)}${pad(`${Number(run.passedSteps) || 0}/${Number(run.totalSteps) || 0}`, 8)}${pad(formatDuration(run.executionTimeMs), 10)}${safeText(run.createdAt, 40)}`
    );
  }
}

// ---------------------------------------------------------------------------
// hosted run (qafind test --cloud)
// ---------------------------------------------------------------------------

export interface HostedRunOptions {
  specPath?: string;
  suiteName?: string;
  targetUrl?: string;
  workflowFile?: string;
  wait?: boolean;
  timeoutSeconds?: number;
  apiKey?: string;
  apiUrl?: string;
}

export interface EvidenceCheck {
  valid: boolean;
  reason?: string;
  keyId?: string;
  pinnedBy: 'QAFIND_TRUSTED_PUBLIC_KEY' | 'login' | 'service';
  warnings: string[];
}

/**
 * Verify a hosted run's evidence. The signing key is taken, in order, from QAFIND_TRUSTED_PUBLIC_KEY, from the key
 * pinned at `qafind login`, and only as a last resort from the service itself (which proves consistency, not origin).
 */
export async function verifyRunEvidence(
  auth: CloudAuth,
  bundle: ComplianceProofBundle,
  fetchKey: () => Promise<{ keyId: string; publicKeyPem: string }> = () => getEvidenceKey(targetOf(auth))
): Promise<EvidenceCheck> {
  const warnings: string[] = [];
  let pinnedBy: EvidenceCheck['pinnedBy'];
  let publicKeyPem: string;
  if (process.env.QAFIND_TRUSTED_PUBLIC_KEY?.trim()) {
    publicKeyPem = process.env.QAFIND_TRUSTED_PUBLIC_KEY.trim();
    pinnedBy = 'QAFIND_TRUSTED_PUBLIC_KEY';
  } else if (auth.stored?.evidencePublicKey && auth.keySource === 'stored') {
    publicKeyPem = auth.stored.evidencePublicKey;
    pinnedBy = 'login';
  } else {
    publicKeyPem = (await fetchKey()).publicKeyPem;
    pinnedBy = 'service';
    warnings.push('The signing key came from the service itself. Run "qafind login" or set QAFIND_TRUSTED_PUBLIC_KEY to pin it.');
  }
  const result = AttestationEngine.verifyBundle(bundle, { trustedPublicKey: publicKeyPem });
  return { valid: result.valid, reason: result.reason, keyId: bundle.publicKeyOrKeyId, pinnedBy, warnings: [...warnings, ...(result.warnings ?? [])] };
}

/** Refuse early what the service would refuse, with a clearer hint. */
export function assertHostedTarget(targetUrl: string): void {
  // Only for development and test deployments of the service (which may allow private targets). The service
  // always enforces its own rules regardless of this check.
  if (process.env.QAFIND_CLOUD_SKIP_TARGET_CHECK === '1') return;
  try {
    checkUrlSyntax(targetUrl);
  } catch (error) {
    if (error instanceof TargetBlockedError) {
      throw new Error(
        `${error.message}: ${targetUrl}. Hosted runs can only reach public addresses, so a local or private URL cannot be tested in the cloud. Use "qafind test --local", or run against a public staging URL.`
      );
    }
    throw error;
  }
}

export async function runHostedTest(options: HostedRunOptions): Promise<RunDetail | { runId: string; status: string }> {
  const auth = requireAuth(options);
  const target = targetOf(auth);
  const config = loadConfig();
  const targetUrl = options.targetUrl || config.baseUrl;
  assertHostedTarget(targetUrl);

  if (options.specPath) {
    logger.warn('Hosted runs execute declarative workflows only; the spec file is not uploaded. Its name is used as the suite name.');
  }
  const workflow = loadWorkflow(options.workflowFile);
  if (!workflow) {
    logger.info('No workflow found in the config or --workflow file: running a smoke check (open the URL and expect a visible page).');
  } else if (JSON.stringify(workflow).includes('${env:')) {
    throw new Error(
      'This workflow uses ${env:NAME} references. Hosted runs never receive your environment, so the values cannot be filled in. Remove the references, or run the workflow locally with "qafind run".'
    );
  }

  const suiteName = options.suiteName || (options.specPath ? path.basename(options.specPath).replace(/\.[^.]+$/, '') : config.projectName);
  const payload = createCloudRunPayload(config, targetUrl, suiteName, workflow ?? undefined);
  const accepted = await submitCloudRun({ apiUrl: auth.apiUrl, apiKey: auth.apiKey, payload });
  const queuePosition = (accepted as { queuePosition?: number | null }).queuePosition;
  logger.success(`Run ${safeText(accepted.runId, 80)} accepted${queuePosition ? ` (position ${queuePosition} in the queue)` : ''}.`);
  const quota = (accepted as { quota?: { used: number; limit: number } }).quota;
  if (quota) out(`  ${quota.used} of ${quota.limit} runs used today.`);

  if (options.wait === false) {
    out(`  Check progress with: qafind runs ${accepted.runId}`);
    return { runId: accepted.runId, status: accepted.status };
  }

  const run = await waitForRun(target, accepted.runId, {
    timeoutMs: (options.timeoutSeconds ?? 600) * 1000,
    intervalMs: Number(process.env.QAFIND_CLOUD_POLL_MS) || undefined,
    onUpdate: (update) => out(`  ${update.status.toLowerCase()}`),
  });
  out();
  printRunDetail(run);

  if (run.hasEvidence) {
    try {
      const bundle = await getRunEvidence(target, run.runId);
      const dir = path.resolve(process.cwd(), config.compliance?.outputDir || './.qafind/compliance');
      ensureDir(dir);
      const file = path.join(dir, `cloud-${safeFileName(run.runId)}.json`);
      writeJsonFile(file, bundle);
      const check = await verifyRunEvidence(auth, bundle);
      out();
      if (check.valid) {
        logger.success(`Evidence verified (${check.keyId}, key pinned by ${check.pinnedBy}). Saved to ${file}`);
      } else {
        logger.error(`Evidence did not verify: ${check.reason}. Saved to ${file}`);
        process.exitCode = 1;
      }
      for (const warning of check.warnings) logger.warn(warning);
    } catch (error) {
      logger.warn(`Could not fetch or verify evidence: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (run.status === 'SUCCESS') logger.success('Hosted run passed.');
  else logger.error(`Hosted run finished as ${run.status}.`);
  return run;
}
