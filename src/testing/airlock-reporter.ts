/**
 * Playwright reporter for the Airlock attach path.
 *
 * An existing Playwright suite keeps its specs and config; add this reporter (usually through the
 * generated `.airlock/playwright.airlock.config.ts` wrapper) and every test outcome is written to
 * the shared manifest `.airlock/reports/<runId>.json` (`src/testing/airlock-report.ts`), which
 * `airlock flake` aggregates across runs.
 *
 * The reporter is structural: the Playwright types are imported with `import type`, so this module
 * has no runtime dependency on @playwright/test and can be loaded by any Playwright version whose
 * reporter callbacks look like the documented `Reporter` interface.
 *
 * Safety: no network, no stdout chatter (`printsToStdio()` is false), errors are caught and warned
 * about once instead of failing the test run, and attachments are recorded as metadata only.
 */
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  AIRLOCK_REPORT_VERSION,
  writeRunReport,
  type AirlockReportTest,
  type AirlockRunReport,
  type AirlockTestStatus,
} from './airlock-report.js';
import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestResult } from '@playwright/test/reporter';

export interface AirlockReporterOptions {
  /** Where `<runId>.json` manifests go. Default `.airlock/reports` (relative to the Playwright cwd). */
  outputDir?: string;
  /** Fixed run id (for CI determinism). Default `run-<compact ISO>-<6 hex>`. */
  runId?: string;
  /** Injectable clock for tests. */
  now?: () => Date;
}

export const DEFAULT_REPORTER_OUTPUT_DIR = '.airlock/reports';
const MAX_ERRORS = 20;
const MAX_ERROR_LENGTH = 2000;
const RUN_ID_RE = /^[A-Za-z0-9._-]{1,120}$/;

const TEST_STATUSES: readonly AirlockTestStatus[] = ['passed', 'failed', 'skipped', 'timedOut', 'interrupted'];

/** Map a Playwright TestResult status onto the manifest status (the names already match). */
export function toAirlockTestStatus(status: unknown): AirlockTestStatus {
  if (typeof status === 'string' && (TEST_STATUSES as readonly string[]).includes(status)) {
    return status as AirlockTestStatus;
  }
  return 'failed';
}

/** `run-20260101T000000Z-a1b2c3` — sortable and safe as a file name. */
export function defaultAirlockRunId(startedAt: Date): string {
  const compact = startedAt.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `run-${compact}-${randomBytes(3).toString('hex')}`;
}

/** Stable per-test key: `${project}::${file}::${titlePath joined}`. */
export function airlockTestId(project: string, file: string, titlePath: readonly string[]): string {
  return `${project}::${file}::${titlePath.join(' › ')}`;
}

/** Normalise a test file path for stable ids across machines: repo-relative, forward slashes. */
export function normalizeTestFile(file: string, rootDir: string | undefined): string {
  let normalized = typeof file === 'string' ? file : '';
  if (!normalized) return '';
  if (rootDir) {
    const relative = path.relative(rootDir, normalized);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) normalized = relative;
  }
  return normalized.split(path.sep).join('/');
}

/**
 * Playwright's `titlePath()` starts with the project name for test cases. Drop that so the
 * manifest's titlePath/`id` do not repeat the project (which is its own field).
 */
export function titlesFromTitlePath(titlePath: readonly string[] | undefined, project: string): string[] {
  const titles = Array.isArray(titlePath) ? titlePath.filter((title): title is string => typeof title === 'string' && title.length > 0) : [];
  if (titles.length > 1 && project && titles[0] === project) return titles.slice(1);
  return [...titles];
}

/** Attachment metadata only: names and paths, never the body buffer. */
export function attachmentMetadata(
  attachments: ReadonlyArray<{ name?: unknown; path?: unknown; contentType?: unknown; body?: unknown }> | undefined,
): AirlockReportTest['attachments'] | undefined {
  if (!Array.isArray(attachments) || attachments.length === 0) return undefined;
  return attachments.slice(0, 50).map((attachment) => ({
    name: typeof attachment.name === 'string' ? attachment.name.slice(0, 200) : 'attachment',
    ...(typeof attachment.path === 'string' && attachment.path.length > 0 ? { path: attachment.path.slice(0, 2048) } : {}),
    ...(typeof attachment.contentType === 'string' && attachment.contentType.length > 0
      ? { contentType: attachment.contentType.slice(0, 120) }
      : {}),
  }));
}

function errorMessages(errors: TestResult['errors'] | undefined): string[] {
  if (!Array.isArray(errors)) return [];
  const messages: string[] = [];
  for (const error of errors) {
    const candidate =
      error && typeof error === 'object'
        ? typeof error.message === 'string' && error.message.length > 0
          ? error.message
          : typeof (error as { value?: unknown }).value === 'string'
            ? (error as { value: string }).value
            : ''
        : typeof error === 'string'
          ? error
          : '';
    const message = candidate.replace(/\r\n/g, '\n').trim().slice(0, MAX_ERROR_LENGTH);
    if (message) messages.push(message);
    if (messages.length >= MAX_ERRORS) break;
  }
  return messages;
}

/** Playwright reporter that writes the shared Airlock run manifest. */
export class AirlockReporter implements Reporter {
  private readonly outputDir: string;
  private readonly now: () => Date;
  private readonly fixedRunId: string | undefined;
  private startedAt: Date | undefined;
  private rootDir: string | undefined;
  private projects: string[] = [];
  private readonly tests = new Map<string, AirlockReportTest>();
  private warned = false;

  constructor(options: AirlockReporterOptions = {}) {
    this.outputDir = typeof options.outputDir === 'string' && options.outputDir.trim() !== '' ? options.outputDir : DEFAULT_REPORTER_OUTPUT_DIR;
    this.now = typeof options.now === 'function' ? options.now : () => new Date();
    this.fixedRunId = typeof options.runId === 'string' && RUN_ID_RE.test(options.runId) ? options.runId : undefined;
  }

  /** Playwright must not replace its default reporters because of this one. */
  printsToStdio(): boolean {
    return false;
  }

  onBegin(config: FullConfig, _suite: Suite): void {
    try {
      this.startedAt = this.now();
      const rootDir = (config as { rootDir?: unknown } | undefined)?.rootDir;
      this.rootDir = typeof rootDir === 'string' && rootDir.length > 0 ? rootDir : undefined;
      const projects = (config as { projects?: unknown } | undefined)?.projects;
      this.projects = Array.isArray(projects)
        ? projects
            .map((project) => (project && typeof (project as { name?: unknown }).name === 'string' ? (project as { name: string }).name : ''))
            .filter((name): name is string => name.length > 0)
        : [];
    } catch (error) {
      this.warn('onBegin', error);
    }
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    try {
      const project = this.projectOf(test);
      const titles = titlesFromTitlePath(safeCall(() => test.titlePath()), project);
      const file = normalizeTestFile(String(safeCall(() => test.location?.file) ?? ''), this.rootDir);
      const fallbackTitle = typeof (test as { title?: unknown }).title === 'string' ? (test as { title: string }).title : 'untitled';
      const titlePath = titles.length > 0 ? titles : [fallbackTitle];
      const id = airlockTestId(project, file, titlePath);
      const attachments = attachmentMetadata(
        (result as { attachments?: Array<{ name?: unknown; path?: unknown; contentType?: unknown; body?: unknown }> } | undefined)
          ?.attachments,
      );
      const record: AirlockReportTest = {
        id,
        title: titlePath[titlePath.length - 1] ?? fallbackTitle,
        titlePath,
        file,
        project,
        status: toAirlockTestStatus((result as { status?: unknown } | undefined)?.status),
        retries: Number.isInteger((result as { retry?: unknown } | undefined)?.retry)
          ? Math.max(0, (result as { retry: number }).retry)
          : 0,
        durationMs: Number.isFinite((result as { duration?: unknown } | undefined)?.duration)
          ? Math.max(0, Math.round((result as { duration: number }).duration))
          : 0,
        errors: errorMessages((result as { errors?: TestResult['errors'] } | undefined)?.errors),
        ...(attachments ? { attachments } : {}),
      };
      // Playwright calls onTestEnd once per retry attempt: the last call is the final outcome.
      this.tests.set(id, record);
    } catch (error) {
      this.warn('onTestEnd', error);
    }
  }

  onEnd(result: FullResult): void {
    try {
      this.writeReport(result);
    } catch (error) {
      this.warn('onEnd', error);
    }
  }

  private projectOf(test: TestCase): string {
    const projectName = safeCall(() => (test as { parent?: { project?: () => { name?: unknown } | undefined } }).parent?.project?.()?.name);
    if (typeof projectName === 'string' && projectName.length > 0) return projectName;
    return 'default';
  }

  private writeReport(result: FullResult): void {
    const finishedAt = this.now();
    const startedAt = this.startedAt ?? finishedAt;
    const durationMs = Number.isFinite((result as { duration?: unknown } | undefined)?.duration)
      ? Math.max(0, Math.round((result as { duration: number }).duration))
      : Math.max(0, finishedAt.getTime() - startedAt.getTime());
    const runId = this.fixedRunId ?? defaultAirlockRunId(startedAt);
    const report: AirlockRunReport = {
      version: AIRLOCK_REPORT_VERSION,
      tool: 'airlock-reporter',
      runId,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs,
      cwd: process.cwd(),
      ...(this.projects.length > 0 ? { projects: this.projects } : {}),
      tests: [...this.tests.values()],
    };
    writeRunReport(this.outputDir, report);
  }

  private warn(hook: string, error: unknown): void {
    if (this.warned) return;
    this.warned = true;
    const message = error instanceof Error ? error.message : String(error);
    // A reporter must never fail the run; warn once and keep going.
    console.warn(`[airlock-reporter] ${hook} failed; no Airlock report written for this run: ${message}`);
  }
}

function safeCall<T>(callback: () => T): T | undefined {
  try {
    return callback();
  } catch {
    return undefined;
  }
}

/** Factory alternative to the default class export (handy for tests and programmatic use). */
export function createAirlockReporter(options: AirlockReporterOptions = {}): AirlockReporter {
  return new AirlockReporter(options);
}

export default AirlockReporter;
