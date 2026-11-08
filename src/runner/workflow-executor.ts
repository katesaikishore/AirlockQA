import type { BrowserContext, Page } from 'playwright-core';
import type { AirlockConfig } from '../types/index.js';
import { interpolateEnv, type Workflow, type WorkflowStep } from '../config/workflow-schema.js';
import type { AirlockRunner } from './airlock-runner.js';
import { logger } from '../utils/logger.js';

export interface WorkflowStepResult {
  index: number;
  action: WorkflowStep['action'];
  target?: string;
  ok: boolean;
  /** Extra information, e.g. the observed HTTP status of a request step. */
  detail?: string;
  error?: string;
}

export interface WorkflowRunResult {
  workflow: string;
  ok: boolean;
  steps: WorkflowStepResult[];
}

export interface WorkflowExecutionOptions {
  page: Page;
  context: BrowserContext;
  runner: AirlockRunner;
  config: AirlockConfig;
  baseUrl: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

function resolveUrl(url: string, baseUrl: string): string {
  return new URL(url, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

function deepInterpolate(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === 'string') return interpolateEnv(value, env);
  if (Array.isArray(value)) return value.map((v) => deepInterpolate(v, env));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepInterpolate(v, env)]));
  }
  return value;
}

async function waitForText(page: Page, selector: string, text: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (true) {
    last = ((await page.locator(selector).first().textContent({ timeout: 1000 }).catch(() => null)) || '').trim();
    if (last.includes(text)) return;
    if (Date.now() >= deadline) {
      throw new Error(`Expected ${selector} to contain "${text}", but its text was "${last}"`);
    }
    await page.waitForTimeout(100);
  }
}

function describeTarget(step: WorkflowStep): string | undefined {
  switch (step.action) {
    case 'goto':
    case 'request':
    case 'fixture':
      return step.url;
    case 'checkpoint':
    case 'restoreCheckpoint':
      return step.name;
    case 'warp':
      return step.duration;
    case 'chaos':
      return step.selector;
    default:
      return step.selector;
  }
}

/**
 * Run a configured workflow step by step. Execution stops at the first failing step, because
 * later steps depend on the page state the earlier ones produce.
 */
export async function executeWorkflow(workflow: Workflow, options: WorkflowExecutionOptions): Promise<WorkflowRunResult> {
  const { page, context, runner, config, baseUrl } = options;
  const env = options.env || process.env;
  const timeout = options.timeoutMs ?? config.compiler?.defaultTimeoutMs ?? 5000;
  const results: WorkflowStepResult[] = [];

  const steps: WorkflowStep[] = workflow.startUrl
    ? [{ action: 'goto', url: workflow.startUrl }, ...workflow.steps]
    : workflow.steps;

  for (const [i, rawStep] of steps.entries()) {
    // Log the uninterpolated target so `${env:...}` values never reach the console.
    const target = describeTarget(rawStep);
    const result: WorkflowStepResult = { index: i + 1, action: rawStep.action, target, ok: false };
    runner.step(rawStep.action.toUpperCase(), target);

    try {
      const step = deepInterpolateStep(rawStep, env);
      switch (step.action) {
        case 'goto':
          await page.goto(resolveUrl(step.url, baseUrl), { waitUntil: 'domcontentloaded', timeout });
          break;
        case 'click':
          await page.locator(step.selector).click({ timeout });
          break;
        case 'fill':
          await page.locator(step.selector).fill(step.value, { timeout });
          break;
        case 'press':
          await page.locator(step.selector).press(step.key, { timeout });
          break;
        case 'select':
          await page.locator(step.selector).selectOption(step.value, { timeout });
          break;
        case 'checkpoint':
          await runner.checkpoint(step.name, page, context);
          result.detail = `saved ${step.name}`;
          break;
        case 'restoreCheckpoint': {
          const restored = await runner.restoreCheckpoint(step.name, page, context);
          if (!restored) throw new Error(`checkpoint '${step.name}' was not found`);
          result.detail = `restored ${step.name}`;
          break;
        }
        case 'warp': {
          const warped = await runner.warpTime(step.duration, page, context);
          result.detail = `${warped.durationString} -> ${warped.targetTimeIso} (${warped.scope})`;
          break;
        }
        case 'fixture': {
          // A page route wins over the context gateway route. The response is served locally; no upstream request is sent.
          const fixtureUrl = resolveUrl(step.url, baseUrl);
          const method = step.method;
          await page.route((url) => url.toString() === fixtureUrl, async (route) => {
            if (route.request().method() !== method) {
              await route.fallback();
              return;
            }
            await route.fulfill({ status: step.status, headers: step.headers, body: step.body });
          });
          result.detail = `${method} ${step.url} -> ${step.status}`;
          break;
        }
        case 'chaos': {
          const report = await runner.chaosAudit(
            async () => { await page.locator(step.selector).click({ timeout }); },
            step.endpointPattern ? { endpointPattern: step.endpointPattern } : {},
            page
          );
          result.detail = `observation: ${report.status}${report.targetEndpoint && report.targetEndpoint !== 'Not observed' ? ` at ${report.targetEndpoint}` : ''}`;
          break;
        }
        case 'waitFor':
          await page.locator(step.selector).first().waitFor({ state: step.state, timeout });
          break;
        case 'expectVisible':
          await page.locator(step.selector).first().waitFor({ state: 'visible', timeout });
          break;
        case 'expectText':
          await waitForText(page, step.selector, step.text, timeout);
          break;
        case 'request': {
          const headers: Record<string, string> = { ...step.headers };
          if (step.phantomSecret) {
            const secret = config.secrets[step.phantomSecret];
            if (!secret) throw new Error(`phantomSecret '${step.phantomSecret}' is not defined in config.secrets`);
            headers.Authorization = `Bearer ${secret.phantom}`;
          }
          let body: string | undefined;
          if (step.body !== undefined) {
            body = typeof step.body === 'string' ? step.body : JSON.stringify(step.body);
            if (typeof step.body !== 'string' && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
              headers['Content-Type'] = 'application/json';
            }
          }
          const outcome = await page.evaluate(
            async ({ url, method, headers, body }) => {
              try {
                const res = await fetch(url, { method, headers, body });
                return { status: res.status as number | null, error: undefined as string | undefined };
              } catch (e) {
                return { status: null, error: e instanceof Error ? e.message : String(e) };
              }
            },
            { url: resolveUrl(step.url, page.url() !== 'about:blank' ? page.url() : baseUrl), method: step.method, headers, body }
          );
          result.detail = outcome.status === null ? `network error: ${outcome.error}` : `HTTP ${outcome.status}`;
          if (step.expectStatus !== undefined) {
            if (outcome.status !== step.expectStatus) {
              throw new Error(`Expected ${step.method} ${step.url} to return HTTP ${step.expectStatus}, got ${result.detail}`);
            }
          } else if (outcome.status === null) {
            throw new Error(`${step.method} ${step.url} failed: ${outcome.error}`);
          }
          logger.info(`  ${step.method} ${step.url} -> ${result.detail}${step.expectStatus !== undefined ? ' (as expected)' : ''}`);
          break;
        }
      }
      result.ok = true;
    } catch (err) {
      result.error = err instanceof Error ? err.message.split('\n')[0] : String(err);
      logger.error(`Step ${result.index} (${rawStep.action}${target ? ` ${target}` : ''}) failed: ${result.error}`);
    }

    results.push(result);
    if (!result.ok) break;
  }

  const ok = results.length === steps.length && results.every((r) => r.ok);
  return { workflow: workflow.name, ok, steps: results };
}

function deepInterpolateStep(step: WorkflowStep, env: NodeJS.ProcessEnv): WorkflowStep {
  return deepInterpolate(step, env) as WorkflowStep;
}
