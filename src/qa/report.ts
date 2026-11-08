/**
 * A human-readable QA report. Pure string building, so the same report is used by the CLI, a PR body and tests.
 * It reports only what the run stored: no guessed fixes, no claim that a failed gate means the app is insecure.
 */

export interface QaReportSuite {
  suite: string;
  status: string;
}

export interface QaReportFinding {
  klass: string;
  severity: string;
  origin: string;
  route: string;
  assertion: string;
}

export interface QaReportArtifact {
  name: string;
  contentType: string;
  size: number;
  route: string | null;
  note: string | null;
}

export interface QaReportRun {
  id: string;
  status: string;
  phase: string | null;
  repo: string | null;
  sha: string | null;
  branch: string | null;
  createdAt?: string | null;
  finishedAt?: string | null;
  gateMode?: string | null;
  suites: QaReportSuite[];
  gate: { exitCode: number; reasons: string[]; continueOnFailure?: boolean } | null;
  findings?: QaReportFinding[];
  artifacts?: QaReportArtifact[];
  error?: string | null;
}

export interface QaReportOptions {
  /** Image path for a screenshot in Markdown. Default: screenshots/<name>. */
  imagePath?: (artifact: QaReportArtifact) => string;
  /** A link to the run in the console, when one exists. */
  runUrl?: string;
  /** True only when the seal was checked with the service key; omitted otherwise. */
  sealVerified?: boolean;
}

const SEVERITY_ORDER: Record<string, number> = { S1: 1, S2: 2, S3: 3, S4: 4 };

function cell(value: unknown, max = 300): string {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .slice(0, max);
}

function code(value: unknown, max = 120): string {
  return `\`${String(value ?? '').replace(/`/g, "'").replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').slice(0, max)}\``;
}

function source(origin: string): string {
  if (origin === 'first_party_observed') return 'Airlock checker';
  if (origin === 'sandbox_self_reported') return 'Your tests (self-reported)';
  return 'Heuristic lead';
}

function sortedFindings(run: QaReportRun): QaReportFinding[] {
  return [...(run.findings ?? [])].sort(
    (a, b) =>
      (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9) ||
      a.route.localeCompare(b.route) ||
      a.klass.localeCompare(b.klass)
  );
}

/** Build the Markdown report. Deterministic: the same run and artifacts produce the same text. */
export function buildQaReport(run: QaReportRun, options: QaReportOptions = {}): string {
  const findings = sortedFindings(run);
  const artifacts = [...(run.artifacts ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const imagePath = options.imagePath ?? ((a) => `screenshots/${a.name}`);
  const title = run.repo ? `${run.repo.replace(/^https:\/\/github\.com\//, '')}@${(run.sha ?? '').slice(0, 7)}` : run.id;
  const lines: string[] = [];

  lines.push(`# Airlock QA report: ${title}`, '');
  lines.push(
    `**Result:** ${run.status}${run.phase ? ` (${run.phase})` : ''}` +
      (run.gate ? ` · **gate:** ${run.gate.exitCode === 0 ? 'passed' : 'failed'}` : ''),
    ''
  );
  lines.push('| | |', '| :--- | :--- |');
  lines.push(`| Run | ${code(run.id)} |`);
  if (run.repo) lines.push(`| Repository | ${cell(run.repo)} |`);
  if (run.sha) lines.push(`| Commit | ${code(run.sha, 40)} |`);
  if (run.branch) lines.push(`| Branch | ${code(run.branch)} |`);
  if (run.gateMode) lines.push(`| Gate mode | ${cell(run.gateMode)} |`);
  if (run.createdAt) lines.push(`| Started | ${cell(run.createdAt)} |`);
  if (run.finishedAt) lines.push(`| Finished | ${cell(run.finishedAt)} |`);
  lines.push(`| Screenshots | ${artifacts.length} |`);
  if (options.runUrl) lines.push(`| Console | ${options.runUrl} |`);
  lines.push('');

  lines.push('## Suites', '');
  if (run.suites.length === 0) {
    lines.push('No suite result was stored.');
  } else {
    lines.push('| Suite | Result |', '| :--- | :--- |');
    for (const s of run.suites) lines.push(`| ${cell(s.suite, 40)} | ${cell(s.status, 20)} |`);
  }
  lines.push('');

  lines.push('## Findings', '');
  if (findings.length === 0) {
    lines.push('No findings were stored for this run.');
  } else {
    lines.push('| Severity | Finding | Route | Seen by |', '| :--- | :--- | :--- | :--- |');
    for (const f of findings) {
      const screenshot = artifacts.find((a) => a.route === f.route);
      const shot = screenshot ? ` ([screenshot](#screenshots))` : '';
      lines.push(
        `| ${cell(f.severity, 4)} | ${cell(f.assertion)}${shot} ${code(f.klass, 40)} | ${code(f.route, 200)} | ${cell(source(f.origin), 40)} |`
      );
    }
  }
  lines.push('');

  if (artifacts.length > 0) {
    lines.push('## Screenshots', '');
    for (const a of artifacts) {
      const where = a.route ? ` — ${a.route}` : '';
      const note = a.note ? ` (${a.note})` : '';
      lines.push(`### ${a.name}${where}${note}`, '', `![${cell(a.route ?? a.name, 120)}](${imagePath(a)})`, '');
    }
  }

  const reasons = [...(run.gate?.reasons ?? [])];
  if (run.error && !reasons.includes(run.error)) reasons.push(run.error);
  if (reasons.length > 0) {
    lines.push('## Reasons', '');
    for (const r of reasons.slice(0, 50)) lines.push(`- ${cell(r, 300)}`);
    lines.push('');
  }

  lines.push('## What this means', '');
  lines.push(
    'This report records what the run stored. A failed gate means the requested suites did not all pass; it is not a ' +
      'statement that the application is secure or compliant. Findings marked “Airlock checker” were seen by Airlock ' +
      'from its own container; findings marked “Your tests” come from the repository’s own test output and are ' +
      'self-reported.'
  );
  if (options.sealVerified) lines.push('', 'The sealed result was verified with the service’s published Ed25519 key.');
  lines.push('', '---', '', `Generated by [AirlockQA](https://qbrin.cloud) for run ${code(run.id)}.`, '');
  return lines.join('\n');
}

/** The directory under the repository where a report and its screenshots are committed. */
export function reportDirectory(runId: string): string {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(runId)) throw new Error('invalid run id');
  return `qa-reports/${runId}`;
}
