/**
 * Tests for the attach planner (`src/attach/attach.ts`): config detection, wrapper rendering,
 * reporter-list preservation (string / single tuple / array) and the writer's force semantics.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AIRLOCK_ATTACH_METADATA_RELATIVE_PATH,
  AIRLOCK_WRAPPER_RELATIVE_PATH,
  DEFAULT_ATTACH_OUTPUT_DIR,
  detectConfigPath,
  planAttach,
  writeAttachPlan,
} from '../src/attach/attach.js';

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeProject(files: Record<string, string | object>, packageJson: object | null = { name: 'airlockqa', version: '1.0.0' }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airlock-attach-'));
  tempDirs.push(dir);
  if (packageJson) files = { ...files, 'package.json': JSON.stringify(packageJson, null, 2) };
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

const CONFIG = `import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests' });\n`;

/** Evaluate the reporter-preservation helper exactly as it is embedded in the generated wrapper. */
function extractExistingReporters(wrapper: string): (reporter: unknown) => unknown[] {
  const match = /function existingReporters\([\s\S]*?\n\}/.exec(wrapper);
  if (!match) throw new Error('existingReporters helper is missing from the generated wrapper');
  // The wrapper is TypeScript; strip just the parameter/return annotations so the exact generated
  // body can be evaluated as JavaScript.
  const source = match[0].replace('(reporter: unknown): unknown[]', '(reporter)');
  expect(source).toContain('looksLikeSingleTuple');
  return new Function(`return (${source});`)() as (reporter: unknown) => unknown[];
}

describe('attach plan', () => {
  it('detects playwright.config.ts and renders a wrapper without touching the config', () => {
    const projectDir = makeProject({ 'playwright.config.ts': CONFIG });
    const plan = planAttach({ projectDir });

    expect(plan.projectDir).toBe(path.resolve(projectDir));
    expect(plan.configPath).toBe(path.join(projectDir, 'playwright.config.ts'));
    expect(plan.wrapperPath).toBe(path.join(projectDir, AIRLOCK_WRAPPER_RELATIVE_PATH));
    expect(plan.wrapperPath.endsWith(path.join('.airlock', 'playwright.airlock.config.ts'))).toBe(true);
    expect(plan.reporterModule).toBe('airlockqa/dist/src/testing/airlock-reporter.js');
    expect(plan.outputDir).toBe(DEFAULT_ATTACH_OUTPUT_DIR);
    expect(plan.outputDir).toBe('.airlock/reports');
    expect(fs.existsSync(plan.wrapperPath)).toBe(false); // planning never writes
    expect(fs.readFileSync(plan.configPath, 'utf8')).toBe(CONFIG);

    expect(plan.wrapperContent).toContain('import baseConfig from "../playwright.config";');
    // Playwright only accepts a reporter by module specifier, not as an imported class.
    expect(plan.wrapperContent).toContain(
      '["airlockqa/dist/src/testing/airlock-reporter.js", { outputDir: ".airlock/reports" }]',
    );
    expect(plan.wrapperContent).not.toContain('import AirlockReporter from');
    expect(plan.wrapperContent).toContain('npx playwright test --config .airlock/playwright.airlock.config.ts');
    expect(plan.wrapperContent).toContain('...base,');
    expect(plan.wrapperContent).toContain('rebaseReporters(base.reporter)');
    expect(plan.wrapperContent).toContain('rebaseUse(base.use)');
    expect(plan.wrapperContent).toContain('rebaseWebServer(base.webServer)');
    expect(plan.wrapperContent).toContain('function rebaseModule(');
    // Playwright resolves config-relative paths against the wrapper's own directory; the wrapper
    // rebases the base config's paths so test discovery still works from .airlock/.
    expect(plan.wrapperContent).toContain('const baseConfigDir = "..";');
    expect(plan.wrapperContent).toContain("testDir: rebasePath(base.testDir ?? '.'),");
    expect(plan.wrapperContent).toContain('const base = baseConfig as Record<string, unknown>;');

    expect(plan.instructions.length).toBeGreaterThanOrEqual(4);
    expect(plan.instructions.join('\n')).toContain('npx playwright test --config .airlock/playwright.airlock.config.ts');
    expect(plan.instructions.join('\n')).toContain('original Playwright config was not modified');
  });

  it('prefers .ts over .js when several configs exist', () => {
    const projectDir = makeProject({
      'playwright.config.ts': CONFIG,
      'playwright.config.js': 'module.exports = {};\n',
    });
    const plan = planAttach({ projectDir });
    expect(plan.configPath).toBe(path.join(projectDir, 'playwright.config.ts'));
  });

  it('accepts an explicit relative config path and keeps its JS extension in the import', () => {
    const projectDir = makeProject({
      'playwright.config.ts': CONFIG,
      'configs/playwright.config.js': 'module.exports = { testDir: "./tests" };\n',
    });
    const plan = planAttach({ projectDir, configPath: 'configs/playwright.config.js' });
    expect(plan.configPath).toBe(path.join(projectDir, 'configs/playwright.config.js'));
    expect(plan.wrapperContent).toContain('import baseConfig from "../configs/playwright.config.js";');
    expect(plan.wrapperContent).toContain('const baseConfigDir = "../configs";');

    const absolutePlan = planAttach({ projectDir, configPath: path.join(projectDir, 'playwright.config.ts') });
    expect(absolutePlan.configPath).toBe(path.join(projectDir, 'playwright.config.ts'));
  });

  it('rejects config paths that escape or do not exist, with actionable errors', () => {
    const projectDir = makeProject({ 'playwright.config.ts': CONFIG });
    expect(() => planAttach({ projectDir, configPath: '../outside.config.ts' })).toThrow(/inside projectDir/i);
    expect(() => planAttach({ projectDir, configPath: path.join(os.tmpdir(), 'nope.config.ts') })).toThrow(/inside projectDir/i);
    expect(() => planAttach({ projectDir, configPath: 'missing.config.ts' })).toThrow(/Playwright config not found/i);
  });

  it('explains what to do when no Playwright config can be found', () => {
    const projectDir = makeProject({});
    expect(() => planAttach({ projectDir })).toThrow(/No Playwright config found/i);
    try {
      planAttach({ projectDir });
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('playwright.config.ts');
      expect(message).toContain('playwright.config.js');
      expect(message).toContain(projectDir);
      expect(message).toMatch(/configPath/i);
    }
    expect(() => detectConfigPath(projectDir)).toThrow(/No Playwright config found/i);
  });

  it('derives the reporter module from the package name, with the airlockqa fallback', () => {
    const repoLike = makeProject({ 'playwright.config.ts': CONFIG }, { name: 'airlockqa' });
    expect(planAttach({ projectDir: repoLike }).reporterModule).toBe('airlockqa/dist/src/testing/airlock-reporter.js');

    const consumerWithDependency = makeProject(
      { 'playwright.config.ts': CONFIG },
      { name: 'acme-storefront', devDependencies: { airlockqa: '^1.0.0' } },
    );
    expect(planAttach({ projectDir: consumerWithDependency }).reporterModule).toBe('airlockqa/dist/src/testing/airlock-reporter.js');

    const unrelatedApp = makeProject({ 'playwright.config.ts': CONFIG }, { name: 'acme-storefront' });
    expect(planAttach({ projectDir: unrelatedApp }).reporterModule).toBe('airlockqa/dist/src/testing/airlock-reporter.js');

    const noPackageJson = makeProject({ 'playwright.config.ts': CONFIG }, null);
    expect(planAttach({ projectDir: noPackageJson }).reporterModule).toBe('airlockqa/dist/src/testing/airlock-reporter.js');

    const absoluteModule = path.join(repoLike, 'dist', 'src', 'testing', 'airlock-reporter.js');
    const plan = planAttach({ projectDir: repoLike, reporterModule: absoluteModule, outputDir: 'reports/airlock' });
    expect(plan.reporterModule).toBe(absoluteModule);
    expect(plan.outputDir).toBe('reports/airlock');
    expect(plan.wrapperContent).toContain(`[${JSON.stringify(absoluteModule)}, { outputDir: "reports/airlock" }]`);
  });

  it('preserves existing reporters of every shape in the generated wrapper', () => {
    const projectDir = makeProject({ 'playwright.config.ts': CONFIG });
    const plan = planAttach({ projectDir });
    const preserve = extractExistingReporters(plan.wrapperContent);

    expect(preserve(undefined)).toEqual([]);
    expect(preserve(null)).toEqual([]);
    expect(preserve(false)).toEqual([]);
    expect(preserve('html')).toEqual(['html']);
    expect(preserve(['html', { open: 'never' }])).toEqual([['html', { open: 'never' }]]); // one tuple, not two reporters
    expect(preserve(['line', ['html', { open: 'never' }]])).toEqual(['line', ['html', { open: 'never' }]]);
    expect(preserve(['list', 'json'])).toEqual(['list', 'json']);

    class CustomReporter {}
    class OtherReporter {}
    expect(preserve(CustomReporter)).toEqual([CustomReporter]);
    expect(preserve([CustomReporter, { verbose: true }])).toEqual([[CustomReporter, { verbose: true }]]);
    expect(preserve([CustomReporter, OtherReporter])).toEqual([CustomReporter, OtherReporter]);
  });

  it('adds deterministic network/clock fixtures behind a tsconfig alias', () => {
    const projectDir = makeProject({
      'playwright.config.ts': CONFIG,
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true } }),
    });
    fs.mkdirSync(path.join(projectDir, 'node_modules', '@playwright'), { recursive: true });
    fs.symlinkSync(
      path.resolve('node_modules', '@playwright', 'test'),
      path.join(projectDir, 'node_modules', '@playwright', 'test'),
      'dir',
    );
    const plan = planAttach({ projectDir, determinism: true });
    expect(plan.determinism).toBe(true);
    expect(plan.wrapperContent).toContain('airlockConfigDir');
    expect(plan.wrapperContent).toContain('tsconfig.airlock.json');
    expect(plan.files.map((file) => path.basename(file.path))).toEqual(['tsconfig.airlock.json', 'airlock-test.ts']);
    const tsconfig = plan.files.find((file) => file.path.endsWith('tsconfig.airlock.json'));
    const shim = plan.files.find((file) => file.path.endsWith('airlock-test.ts'));
    expect(tsconfig?.content).toContain('"@playwright/test"');
    expect(tsconfig?.content).toContain('./airlock-test');
    expect(tsconfig?.content).toContain('"extends": "../tsconfig.json"');
    expect(shim?.content).toContain('airlockDeterminismFixtures');
    expect(shim?.content).toContain('pw.test.extend');
    const written = writeAttachPlan(plan);
    expect(written.some((file) => file.endsWith('tsconfig.airlock.json'))).toBe(true);
    expect(written.some((file) => file.endsWith('airlock-test.ts'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, '.airlock', 'airlock-test.ts'))).toBe(true);
  });

  it('writes the wrapper and .airlock/attach.json, then refuses to overwrite without force', () => {
    const projectDir = makeProject({ 'playwright.config.ts': CONFIG });
    const plan = planAttach({ projectDir });
    const createdAt = new Date('2026-03-04T05:06:07.000Z');
    const written = writeAttachPlan(plan, { now: () => createdAt });

    const wrapperPath = path.join(projectDir, AIRLOCK_WRAPPER_RELATIVE_PATH);
    const metadataPath = path.join(projectDir, AIRLOCK_ATTACH_METADATA_RELATIVE_PATH);
    expect(written).toEqual([wrapperPath, metadataPath]);
    expect(fs.readFileSync(wrapperPath, 'utf8')).toBe(plan.wrapperContent);
    expect(fs.readFileSync(path.join(projectDir, 'playwright.config.ts'), 'utf8')).toBe(CONFIG);
    expect(fs.readFileSync(metadataPath, 'utf8')).toBe(
      JSON.stringify(
        {
          configPath: 'playwright.config.ts',
          reporterModule: plan.reporterModule,
          outputDir: DEFAULT_ATTACH_OUTPUT_DIR,
          createdAt: createdAt.toISOString(),
        },
        null,
        2,
      ) + '\n',
    );

    // Replanning is fine; writing again is refused and leaves the existing wrapper untouched.
    const replanned = planAttach({ projectDir });
    expect(() => writeAttachPlan(replanned)).toThrow(/Refusing to overwrite \.airlock\/playwright\.airlock\.config\.ts/i);
    expect(fs.readFileSync(wrapperPath, 'utf8')).toBe(plan.wrapperContent);

    // force replaces it, using the new plan's content.
    const replaced = planAttach({ projectDir, outputDir: 'reports/airlock' });
    expect(() => writeAttachPlan(replaced, { force: true })).not.toThrow();
    expect(fs.readFileSync(wrapperPath, 'utf8')).toBe(replaced.wrapperContent);
    expect(fs.readFileSync(wrapperPath, 'utf8')).toContain('outputDir: "reports/airlock"');
    expect(fs.readFileSync(path.join(projectDir, 'playwright.config.ts'), 'utf8')).toBe(CONFIG);
  });

  it('reports a missing project directory clearly', () => {
    expect(() => planAttach({ projectDir: path.join(os.tmpdir(), 'airlock-attach-does-not-exist') })).toThrow(
      /Project directory not found/i,
    );
    expect(() => planAttach({ projectDir: '' })).toThrow(/needs projectDir/i);
  });
});
