import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { auditPlaywrightDirectory, renderHuntReport } from '../src/hunt/index.js';

function fixtureDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qafind-hunt-'));
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'tests', 'hunt.spec.ts'),
    `import { expect, test } from '@playwright/test';\n\ntest('no assertion here', async ({ page }) => {\n  await page.goto('/');\n});\n\ntest('unawaited matcher', async ({ page }) => {\n  expect(page.locator('h1')).toHaveText('Welcome');\n});\n\ntest('fixed sleep', async ({ page }) => {\n  await page.waitForTimeout(1000);\n  await expect(page.locator('h1')).toBeVisible();\n});\n\ntest.only('focused case', async ({ page }) => {\n  await page.goto('/');\n  await expect(page.locator('h1')).toBeVisible();\n});\n`,
  );
  return dir;
}

describe('Playwright QA hunt audit', () => {
  it('finds assertion-free tests, unawaited matchers, fixed waits and focused tests', async () => {
    const dir = fixtureDir();
    const audit = await auditPlaywrightDirectory(dir);
    const rules = audit.candidates.map((candidate) => candidate.rule);
    expect(rules).toContain('assertion-free-test');
    expect(rules).toContain('unawaited-expect');
    expect(rules).toContain('fixed-wait');
    expect(rules).toContain('focused-test');
    expect(audit.files).toBe(1);
    expect(audit.testCalls).toBeGreaterThan(1);
    const report = renderHuntReport(audit);
    expect(report).toContain('Playwright QA audit');
    expect(report).toContain('unawaited-expect');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not apply Playwright async-matcher rules to Vitest/Testing Library files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qafind-hunt-vitest-'));
    fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'tests', 'pane.test.tsx'),
      `import { expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

it('renders a visible pane', () => {
  render(<div data-testid="pane">Pane</div>);
  expect(screen.getByTestId('pane')).toBeVisible();
});
`,
    );
    const audit = await auditPlaywrightDirectory(dir);
    expect(audit.candidates).toHaveLength(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('filters by minimum severity', async () => {
    const dir = fixtureDir();
    const audit = await auditPlaywrightDirectory(dir, { minSeverity: 'high' });
    expect(audit.candidates.every((candidate) => candidate.severity === 'high')).toBe(true);
    expect(audit.candidates.some((candidate) => candidate.rule === 'focused-test')).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects a missing directory', async () => {
    await expect(auditPlaywrightDirectory('/tmp/definitely-not-a-real-qafind-hunt-path')).rejects.toThrow(/Directory not found/);
  });
});
