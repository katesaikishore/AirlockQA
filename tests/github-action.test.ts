import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as yaml from 'js-yaml';

const action = yaml.load(readFileSync('action.yml', 'utf8')) as any;

describe('Airlock QA GitHub Action', () => {
  test('is a composite action with the documented inputs and outputs', () => {
    expect(action.name).toBe('Airlock QA');
    expect(action.runs.using).toBe('composite');
    expect(Object.keys(action.inputs)).toEqual(['api-key', 'suites', 'gate', 'report-dir', 'comment']);
    expect(action.inputs['api-key'].required).toBe(true);
    expect(action.outputs['run-id'].value).toContain('steps.qa.outputs.run-id');
  });

  test('runs QA against the pull-request commit and always writes/uploads the report', () => {
    const steps = action.runs.steps as any[];
    const qa = steps.find((step) => step.id === 'qa');
    expect(qa).toBeTruthy();
    expect(qa['continue-on-error']).toBe(true);
    expect(qa.env.QA_SHA).toContain('pull_request.head.sha');
    expect(qa.env.GH_TOKEN).toContain('github.token');
    const report = steps.find((step) => step.name === 'Write the report');
    expect(report.if).toBe('always()');
    const upload = steps.find((step) => step.uses === 'actions/upload-artifact@v4');
    expect(upload).toBeTruthy();
    expect(upload.if).toBe('always()');
  });
});
