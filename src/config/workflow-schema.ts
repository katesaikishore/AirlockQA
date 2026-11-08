import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';

/**
 * Optional `workflow` section of airlock.config.json, run by `airlock run`.
 *
 * String values may reference environment variables as `${env:NAME}` so credentials never
 * have to be written into the config file.
 */

const selector = z.string().min(1, 'selector cannot be empty');

export const WorkflowStepSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('goto'), url: z.string().default('/') }),
  z.object({ action: z.literal('click'), selector }),
  z.object({ action: z.literal('fill'), selector, value: z.string() }),
  z.object({ action: z.literal('press'), selector, key: z.string().min(1) }),
  z.object({ action: z.literal('select'), selector, value: z.string() }),
  z.object({ action: z.literal('checkpoint'), name: z.string().min(1) }),
  z.object({ action: z.literal('restoreCheckpoint'), name: z.string().min(1) }),
  z.object({ action: z.literal('warp'), duration: z.string().min(1).max(40) }),
  z.object({
    action: z.literal('fixture'),
    /** Absolute URL or a path relative to the workflow's base URL. The response is served in the page, not sent upstream. */
    url: z.string().min(1).max(2048),
    method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']).default('GET'),
    status: z.number().int().min(100).max(599).default(200),
    headers: z.record(z.string(), z.string()).default({}),
    body: z.string().max(100_000).default(''),
  }),
  z.object({
    action: z.literal('chaos'),
    selector,
    /** Optional URL fragment the observed mutation request must match. Observation only; no request is replayed. */
    endpointPattern: z.string().max(200).optional(),
  }),
  z.object({
    action: z.literal('waitFor'),
    selector,
    state: z.enum(['attached', 'detached', 'visible', 'hidden']).default('visible'),
  }),
  z.object({ action: z.literal('expectVisible'), selector }),
  z.object({ action: z.literal('expectText'), selector, text: z.string() }),
  z.object({
    action: z.literal('request'),
    /** Absolute URL or a path relative to the page's origin. The request is sent from the page, so it passes through the gateway. */
    url: z.string().min(1),
    method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']).default('GET'),
    headers: z.record(z.string(), z.string()).default({}),
    body: z.unknown().optional(),
    /** Name of a configured secret whose phantom token is sent as `Authorization: Bearer <phantom>`. */
    phantomSecret: z.string().optional(),
    /** The step fails unless the response has exactly this status (e.g. 403 for a blocked mutation). */
    expectStatus: z.number().int().optional(),
  }),
]);

export const WorkflowSchema = z.object({
  name: z.string().default('workflow'),
  /** Optional start URL. Relative URLs are resolved against `baseUrl`. */
  startUrl: z.string().optional(),
  steps: z.array(WorkflowStepSchema).min(1, 'workflow.steps must contain at least one step'),
});

export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;
export type Workflow = z.infer<typeof WorkflowSchema>;

const CONFIG_CANDIDATES = ['airlock.config.json', '.airlock/config.json', 'airlock.json'];

/** Parse a workflow object, reporting schema errors with their path. */
export function parseWorkflow(raw: unknown, source = 'workflow'): Workflow {
  const result = WorkflowSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${[source, ...i.path.map(String)].join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid workflow in ${source}:\n${issues}`);
  }
  return result.data;
}

/**
 * Load a workflow from a standalone JSON file (either `{ workflow: {...} }` or the workflow
 * object itself) or, when no file is given, from the `workflow` key of the Airlock config.
 * Returns null when no workflow is defined.
 */
export function loadWorkflow(filePath?: string, cwd: string = process.cwd()): Workflow | null {
  if (filePath) {
    const full = path.resolve(cwd, filePath);
    if (!fs.existsSync(full)) throw new Error(`Workflow file not found: ${full}`);
    const raw = JSON.parse(fs.readFileSync(full, 'utf8'));
    return parseWorkflow(raw && typeof raw === 'object' && 'workflow' in raw ? raw.workflow : raw, full);
  }

  for (const candidate of CONFIG_CANDIDATES) {
    const full = path.resolve(cwd, candidate);
    if (!fs.existsSync(full)) continue;
    const raw = JSON.parse(fs.readFileSync(full, 'utf8'));
    if (raw?.workflow === undefined) return null;
    return parseWorkflow(raw.workflow, `${candidate}#workflow`);
  }
  return null;
}

/** Replace `${env:NAME}` references. Throws when a referenced variable is unset. */
export function interpolateEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const resolved = env[name];
    if (resolved === undefined) {
      throw new Error(`Workflow references environment variable ${name}, which is not set`);
    }
    return resolved;
  });
}
