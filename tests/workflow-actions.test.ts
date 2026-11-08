import { describe, expect, test } from 'bun:test';
import { WorkflowSchema } from '../src/config/workflow-schema.ts';
import { CreateRunBodySchema } from '../cloud/shared/contract.ts';
import { executeWorkflow } from '../src/runner/workflow-executor.ts';

describe('workflow actions: schema', () => {
  test('accepts warp, checkpoint restore, fixture and chaos steps', () => {
    const workflow = WorkflowSchema.parse({
      name: 'cloud-capabilities',
      steps: [
        { action: 'checkpoint', name: 'signed-in' },
        { action: 'warp', duration: '+14 days' },
        { action: 'fixture', url: '/api/stats', method: 'GET', status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' },
        { action: 'restoreCheckpoint', name: 'signed-in' },
        { action: 'chaos', selector: '[data-testid="pay"]', endpointPattern: '/api/checkout' },
      ],
    });
    expect(workflow.steps.map((step) => step.action)).toEqual(['checkpoint', 'warp', 'fixture', 'restoreCheckpoint', 'chaos']);
  });

  test('the cloud request accepts a same-origin fixture and refuses an off-host one', () => {
    const base = {
      suiteName: 'fixtures',
      targetUrl: 'https://example.com/',
      workflow: {
        name: 'fixtures',
        steps: [
          { action: 'goto', url: '/' },
          { action: 'fixture', url: '/api/stats', status: 200, body: '{"ok":true}' },
        ],
      },
    };
    expect(CreateRunBodySchema.safeParse(base).success).toBe(true);
    const offHost = {
      ...base,
      workflow: { name: 'fixtures', steps: [{ action: 'fixture', url: 'https://evil.example/api', status: 200, body: 'x' }] },
    };
    expect(CreateRunBodySchema.safeParse(offHost).success).toBe(false);
  });
});

describe('workflow actions: executor', () => {
  test('warp and checkpoint restore report what they did', async () => {
    const calls: string[] = [];
    const runner = {
      step: () => {},
      checkpoint: async (name: string) => { calls.push('save:' + name); },
      restoreCheckpoint: async (name: string) => { calls.push('restore:' + name); return name === 'signed-in'; },
      warpTime: async (duration: string) => { calls.push('warp:' + duration); return { durationString: duration, targetTimeIso: '2026-11-22T00:00:00.000Z', scope: 'browser-page' }; },
      chaosAudit: async () => ({ status: 'OBSERVED', targetEndpoint: '/api/checkout' }),
    };
    const result = await executeWorkflow(
      WorkflowSchema.parse({ steps: [{ action: 'checkpoint', name: 'signed-in' }, { action: 'warp', duration: '+14 days' }, { action: 'restoreCheckpoint', name: 'signed-in' }] }),
      { page: {} as any, context: {} as any, runner: runner as any, config: {} as any, baseUrl: 'https://example.com/' }
    );
    expect(result.ok).toBe(true);
    expect(calls).toEqual(['save:signed-in', 'warp:+14 days', 'restore:signed-in']);
    expect(result.steps[1].detail).toContain('+14 days');
    expect(result.steps[2].detail).toBe('restored signed-in');
  });

  test('a missing checkpoint fails the step', async () => {
    const runner = { step: () => {}, restoreCheckpoint: async () => false };
    const result = await executeWorkflow(
      WorkflowSchema.parse({ steps: [{ action: 'restoreCheckpoint', name: 'missing' }] }),
      { page: {} as any, context: {} as any, runner: runner as any, config: {} as any, baseUrl: 'https://example.com/' }
    );
    expect(result.ok).toBe(false);
    expect(result.steps[0].error).toContain("checkpoint 'missing' was not found");
  });

  test('a fixture serves the declared response only for its method', async () => {
    let handler: any;
    let predicate: any;
    const page = { route: async (match: any, fn: any) => { predicate = match; handler = fn; } };
    const runner = { step: () => {} };
    const result = await executeWorkflow(
      WorkflowSchema.parse({ steps: [{ action: 'fixture', url: '/api/stats', status: 201, headers: { 'x-test': '1' }, body: '{"ok":true}' }] }),
      { page: page as any, context: {} as any, runner: runner as any, config: {} as any, baseUrl: 'https://example.com/' }
    );
    expect(result.ok).toBe(true);
    expect(predicate(new URL('https://example.com/api/stats'))).toBe(true);
    let fulfilled: any;
    let fellBack = false;
    await handler({
      request: () => ({ method: () => 'GET' }),
      fulfill: async (options: any) => { fulfilled = options; },
      fallback: async () => { fellBack = true; },
    });
    expect(fulfilled).toEqual({ status: 201, headers: { 'x-test': '1' }, body: '{"ok":true}' });
    await handler({ request: () => ({ method: () => 'POST' }), fulfill: async () => {}, fallback: async () => { fellBack = true; } });
    expect(fellBack).toBe(true);
  });

  test('chaos is an observation step, not a replay', async () => {
    let clicked = 0;
    let audit: any;
    const page = { locator: () => ({ click: async () => { clicked++; } }) };
    const runner = {
      step: () => {},
      chaosAudit: async (action: () => Promise<void>, options: any) => {
        audit = options;
        await action();
        return { status: 'RISK_INDICATED', targetEndpoint: '/api/checkout' };
      },
    };
    const result = await executeWorkflow(
      WorkflowSchema.parse({ steps: [{ action: 'chaos', selector: '[data-testid="pay"]', endpointPattern: '/api/checkout' }] }),
      { page: page as any, context: {} as any, runner: runner as any, config: {} as any, baseUrl: 'https://example.com/' }
    );
    expect(result.ok).toBe(true);
    expect(clicked).toBe(1);
    expect(audit).toEqual({ endpointPattern: '/api/checkout' });
    expect(result.steps[0].detail).toContain('RISK_INDICATED');
  });
});
