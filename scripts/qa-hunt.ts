#!/usr/bin/env bun
/**
 * Run Airlock QA against a list of public repositories, one at a time, and write a report for each.
 *
 *   bun scripts/qa-hunt.ts --repos scripts/qa-hunt-repos.txt --max 5 --suites smoke,explore
 *   bun scripts/qa-hunt.ts --max 3 --create-pr
 *
 * The service runs one QA job at a time; this script waits for each. A failed build or a failed suite is a result,
 * not an exception: it is written into the report and the next repository is tried. Screenshots from Airlock's own
 * checker are downloaded by `airlock qa report`.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { CreateQaRunBodySchema } from '../cloud/shared/contract.js';
import { resolveCloudAuth } from '../src/router/cloud-credentials.js';
import { submitQaRun, waitForQaRun, type QaTarget } from '../src/router/qa-cli.js';
import { qaReportCommand } from '../src/qa/report-command.js';

const exec = promisify(execFile);
const run = async (cmd: string, args: string[], cwd = process.cwd()) => {
  const { stdout } = await exec(cmd, args, { cwd, timeout: 120_000, maxBuffer: 8 << 20 });
  return String(stdout).trim();
};
const gh = (path: string, jq?: string) => run('gh', ['api', path, ...(jq ? ['--jq', jq] : [])]);

interface Args {
  repos: string;
  max: number;
  suites: string[];
  out: string;
  createPr: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const max = Number(get('--max') || 5);
  if (!Number.isInteger(max) || max < 1 || max > 20) throw new Error('--max must be 1 to 20');
  const date = new Date().toISOString().slice(0, 10);
  return {
    repos: get('--repos') || 'scripts/qa-hunt-repos.txt',
    max,
    suites: (get('--suites') || 'smoke,explore').split(',').map((s) => s.trim()).filter(Boolean),
    out: path.resolve(get('--out') || `qa-hunt/${date}`),
    createPr: argv.includes('--create-pr'),
    dryRun: argv.includes('--dry-run'),
  };
}

function readRepos(file: string): string[] {
  if (!fs.existsSync(file)) throw new Error(`repository list not found: ${file}`);
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, ''))
    .filter((l) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(l));
}

/** Read the scripts that actually exist in the repository at this commit. Never send test:explore: the checker is the point. */
async function scriptsAt(slug: string, sha: string): Promise<Record<string, string>> {
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${slug}/${sha}/package.json`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return {};
    const pkg = (await res.json()) as { scripts?: Record<string, unknown> };
    const out: Record<string, string> = {};
    for (const key of ['start', 'test', 'test:integration', 'test:e2e', 'test:a11y', 'test:security', 'test:load']) {
      if (typeof pkg.scripts?.[key] === 'string') out[key] = key;
    }
    return out;
  } catch {
    return {};
  }
}

async function submitWithWait(target: QaTarget, body: unknown): Promise<any> {
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      const submitted = await submitQaRun(body, target);
      return await waitForQaRun(target, submitted.id, { intervalMs: 15_000, timeoutMs: 75 * 60_000 });
    } catch (err) {
      const message = (err as Error).message;
      if (/\b429\b|another qa run|rate-limiting/i.test(message)) {
        process.stderr.write(`waiting for the QA slot (${message.split('\n')[0]})\n`);
        await new Promise((r) => setTimeout(r, 60_000));
        continue;
      }
      throw err;
    }
  }
  throw new Error('gave up waiting for a QA slot');
}

async function createReportPr(out: string, statuses: Array<{ repo: string; status: string; id: string }>): Promise<void> {
  const root = await run('git', ['rev-parse', '--show-toplevel']);
  const rel = path.relative(root, out);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('--create-pr needs the report directory inside the repository');
  const dirty = (await run('git', ['status', '--porcelain'], root))
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((line) => {
      const changed = line.slice(3).trim().replace(/\/+$/, '');
      return !(changed === rel || changed.startsWith(rel + '/') || rel.startsWith(changed + '/'));
    });
  if (dirty.length) throw new Error('--create-pr needs a clean working tree (commit or stash other changes first)');
  const repo = await run('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], root);
  const base = await run('gh', ['repo', 'view', repo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], root);
  const branch = `airlock-qa/hunt-${new Date().toISOString().slice(0, 10)}`;
  await run('git', ['switch', '-c', branch], root);
  await run('git', ['add', '--', rel], root);
  await run('git', ['commit', '-m', `qa: Airlock QA hunt for ${new Date().toISOString().slice(0, 10)}`], root);
  await run('git', ['push', '-u', 'origin', 'HEAD'], root);
  const body = [
    'Automated Airlock QA hunt over public repositories.',
    '',
    '| Repository | Status | Run |',
    '| :--- | :--- | :--- |',
    ...statuses.map((s) => `| ${s.repo} | ${s.status} | \`${s.id}\` |`),
    '',
    'Each report and its failure screenshots are in the diff under `' + rel + '/`.',
  ].join('\n');
  const bodyFile = path.join(out, 'PR_BODY.md');
  fs.writeFileSync(bodyFile, body + '\n');
  const url = await run('gh', ['pr', 'create', '--repo', repo, '--base', base, '--head', branch, '--title', `Airlock QA hunt: ${statuses.length} repositories`, '--body-file', bodyFile], root);
  process.stdout.write(`PR: ${url}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repos = readRepos(args.repos);
  if (repos.length === 0) throw new Error(`no repositories in ${args.repos}`);
  const auth = resolveCloudAuth({});
  if (!auth) throw new Error('Not signed in. Run "airlock login" (or set AIRLOCK_API_KEY) first.');
  const target: QaTarget = { apiUrl: auth.apiUrl, apiKey: auth.apiKey };
  fs.mkdirSync(args.out, { recursive: true });
  const summary: string[] = ['# Airlock QA hunt', '', `Run at ${new Date().toISOString()}`, '', '| Repository | Status | Phase | Findings | Report |', '| :--- | :--- | :--- | :--- | :--- |'];
  const statuses: Array<{ repo: string; status: string; id: string }> = [];
  let used = 0;
  for (const repo of repos) {
    if (used >= args.max) break;
    const branch = (await gh(`repos/${repo}`, '.default_branch')) || 'main';
    const sha = (await gh(`repos/${repo}/commits/${branch}`, '.sha')).trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      process.stderr.write(`skip ${repo}: no commit SHA\n`);
      continue;
    }
    const scripts = await scriptsAt(repo, sha);
    const body = CreateQaRunBodySchema.parse({
      repo: `https://github.com/${repo}`,
      sha,
      branch,
      scripts,
      suites: args.suites,
      gate: 'default',
      timeoutMinutes: 45,
    });
    if (args.dryRun) {
      process.stdout.write(`${repo}@${sha.slice(0, 7)} suites=${args.suites.join(',')} scripts=${Object.keys(scripts).join(',') || 'none'}\n`);
      used++;
      continue;
    }
    process.stdout.write(`${repo}@${sha.slice(0, 7)} ... `);
    const result = await submitWithWait(target, body);
    const idle = path.join(args.out, repo.replace('/', '__'));
    try {
      await qaReportCommand(result.id, { out: idle });
    } catch (err) {
      process.stderr.write(`report for ${repo} failed: ${(err as Error).message}\n`);
    }
    const findings = Array.isArray(result.findings) ? result.findings.length : 0;
    statuses.push({ repo, status: result.status, id: result.id });
    summary.push(`| ${repo} | ${result.status} | ${result.phase ?? ''} | ${findings} | [report](${repo.replace('/', '__')}/report.md) |`);
    process.stdout.write(`${result.status} ${result.phase ?? ''} (${findings} findings)\n`);
    fs.writeFileSync(path.join(args.out, 'summary.md'), summary.join('\n') + '\n');
    used++;
    if (/quota/i.test(result.error ?? '')) break;
  }
  fs.writeFileSync(path.join(args.out, 'summary.md'), summary.join('\n') + '\n');
  process.stdout.write(`summary: ${path.join(args.out, 'summary.md')}\n`);
  if (args.createPr && !args.dryRun && statuses.length > 0) await createReportPr(args.out, statuses);
}

main().catch((err) => {
  process.stderr.write(`qa hunt: ${(err as Error).message}\n`);
  process.exit(1);
});
