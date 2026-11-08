import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { resolveCloudAuth } from '../router/cloud-credentials.js';
import {
  downloadQaArtifact,
  getQaRun,
  listQaArtifacts,
  verifyQaSeal,
  type QaArtifactInfo,
  type QaRunDetail,
  type QaTarget,
} from '../router/qa-cli.js';
import { buildQaReport, reportDirectory, type QaReportRun } from './report.js';

const exec = promisify(execFile);

export interface QaReportOptions {
  out?: string;
  pr?: string;
  repo?: string;
  createPr?: boolean;
  apiUrl?: string;
  title?: string;
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, timeout: 120_000, maxBuffer: 8 << 20 });
  return String(stdout).trim();
}

async function gh(args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec('gh', args, { cwd, timeout: 120_000, maxBuffer: 8 << 20 });
  return String(stdout).trim();
}

function toReportRun(run: QaRunDetail, artifacts: QaArtifactInfo[]): QaReportRun {
  return {
    id: run.id,
    status: run.status,
    phase: run.phase,
    repo: run.repo ?? null,
    sha: run.sha ?? null,
    branch: run.branch ?? null,
    createdAt: run.createdAt ?? null,
    finishedAt: run.finishedAt ?? null,
    gateMode: run.gateMode ?? null,
    suites: run.suites ?? [],
    gate: run.gate ?? null,
    findings: run.findings ?? [],
    artifacts: artifacts.map((a) => ({
      name: a.name,
      contentType: a.contentType,
      size: a.size,
      route: a.route,
      note: a.note,
    })),
    error: run.error ?? run.failureReason ?? null,
  };
}

function rawUrl(repo: string, branch: string, dir: string, name: string): string {
  const pathPart = `${dir}/screenshots/${name}`.split('/').map(encodeURIComponent).join('/');
  const branchPart = branch.split('/').map(encodeURIComponent).join('/');
  return `https://raw.githubusercontent.com/${repo}/${branchPart}/${pathPart}`;
}

async function downloadScreenshots(target: QaTarget, runId: string, artifacts: QaArtifactInfo[], outDir: string): Promise<void> {
  if (artifacts.length === 0) return;
  const dir = path.join(outDir, 'screenshots');
  fs.mkdirSync(dir, { recursive: true });
  for (const artifact of artifacts) {
    const got = await downloadQaArtifact(target, runId, artifact.name);
    if (!got.contentType.startsWith('image/')) throw new Error(`screenshot ${artifact.name} is not an image (${got.contentType})`);
    fs.writeFileSync(path.join(dir, artifact.name), got.bytes);
  }
}

/**
 * `airlock qa report`: download a run, its findings and its screenshots, write a Markdown report, and optionally
 * post it to a PR or open a PR that commits the report. A PR is created only in the repository the command runs in;
 * opening a PR on someone else's repository needs their permission, which this command cannot invent.
 */
export async function qaReportCommand(runId: string, opts: QaReportOptions): Promise<void> {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(runId)) throw new Error('invalid QA run id');
  const auth = resolveCloudAuth({ apiUrl: opts.apiUrl });
  if (!auth) throw new Error('Not signed in. Run "airlock login" (or set AIRLOCK_API_KEY) first.');
  const target: QaTarget = { apiUrl: auth.apiUrl, apiKey: auth.apiKey };
  const run = await getQaRun(target, runId);
  const artifacts = run.artifacts?.length ? run.artifacts : await listQaArtifacts(target, runId);
  const outDir = path.resolve(opts.out || reportDirectory(runId));
  const sealVerified = verifyQaSeal(run.evidence);
  const reportRun = toReportRun(run, artifacts);

  fs.mkdirSync(outDir, { recursive: true });
  await downloadScreenshots(target, runId, artifacts, outDir);
  const reportPath = path.join(outDir, 'report.md');
  fs.writeFileSync(
    reportPath,
    buildQaReport(reportRun, { imagePath: (a) => `screenshots/${a.name}`, sealVerified })
  );
  process.stdout.write(`report: ${reportPath}\n`);
  if (artifacts.length) process.stdout.write(`screenshots: ${artifacts.length} in ${path.join(outDir, 'screenshots')}\n`);

  if (opts.pr) {
    if (!/^[1-9][0-9]*$/.test(opts.pr)) throw new Error('--pr takes a pull request number');
    const args = ['pr', 'comment', opts.pr, '--body-file', reportPath];
    if (opts.repo) args.push('--repo', opts.repo);
    const url = await gh(args, process.cwd());
    process.stdout.write(`${url || 'PR comment posted'}\n`);
  }

  if (opts.createPr) {
    const repo = opts.repo || (await gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], process.cwd()));
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error(`could not read the GitHub repository (${repo})`);
    const root = await git(['rev-parse', '--show-toplevel'], process.cwd());
    const relOut = path.relative(root, outDir);
    if (!relOut || relOut.startsWith('..') || path.isAbsolute(relOut)) {
      throw new Error('--create-pr writes the report inside the repository; choose --out under the repository root');
    }
    // The report directory is the only allowed change; everything else must be committed already.
    const dirty = (await git(['status', '--porcelain'], root))
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => {
        const changed = line.slice(3).trim().replace(/\/+$/, '');
        // Git reports an untracked directory as `?? qa-reports/`, so allow both the directory and its children.
        return !(changed === relOut.replace(/\/+$/, '') || changed.startsWith(relOut + '/') || relOut.startsWith(changed + '/'));
      });
    if (dirty.length) throw new Error('--create-pr needs a clean working tree (commit or stash other changes first)');
    const branch = `airlock-qa/report-${runId.toLowerCase()}`;
    const defaultBranch = await gh(['repo', 'view', repo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], root);
    await git(['switch', '-c', branch], root);
    await git(['add', '--', relOut], root);
    await git(['commit', '-m', `qa: Airlock QA report for ${runId}`], root);
    await git(['push', '-u', 'origin', 'HEAD'], root);
    const body = buildQaReport(reportRun, { imagePath: (a) => rawUrl(repo, branch, path.relative(root, outDir), a.name), sealVerified });
    const bodyFile = path.join(outDir, '.pr-body.md');
    fs.writeFileSync(bodyFile, body);
    const title = opts.title || `Airlock QA report: ${runId}`;
    const url = await gh(['pr', 'create', '--repo', repo, '--base', defaultBranch, '--head', branch, '--title', title, '--body-file', bodyFile], root);
    process.stdout.write(`PR: ${url}\n`);
  }
}
