#!/usr/bin/env bun
import { Command } from 'commander';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { chromium } from 'playwright-core';
import { loadConfig } from '../src/config/loader.js';
import { TraceRecorder } from '../src/compiler/trace-recorder.js';
import { AstGenerator } from '../src/compiler/ast-generator.js';
import { InteractionRecorder, REDACTED_VALUE } from '../src/compiler/interaction-recorder.js';
import { AirlockRunner } from '../src/runner/airlock-runner.js';
import { executeWorkflow } from '../src/runner/workflow-executor.js';
import { loadWorkflow, WorkflowStepSchema } from '../src/config/workflow-schema.js';
import { runPlaywrightSpecs, type LocalTestRunResult } from '../src/router/local-test-runner.js';
import { buildForkPlan, runForkVariation } from '../src/forker/fork-plan.js';
import { AttestationEngine } from '../src/compliance/attestation.js';
import { DatasetCollector } from '../src/healer/dataset-collector.js';
import { startDashboardServer } from '../src/dashboard/server.js';
import { ensureDir, readJsonFile, writeJsonFile } from '../src/utils/files.js';
import { logger } from '../src/utils/logger.js';
import { z } from 'zod';
import type { ComplianceProofBundle, ExecutionTrace } from '../src/types/index.js';

const program = new Command();

program
  .name('airlock')
  .description('AirlockQA: Zero-Trust, Self-Compiling, Time-Traveling AI QA Engine')
  .version('1.0.0');

// ==========================================
// COMMAND: INIT
// ==========================================
program
  .command('init')
  .description('Initialize AirlockQA configuration and sample policies')
  .action(() => {
    logger.banner();
    const configPath = path.resolve(process.cwd(), 'airlock.config.json');
    if (fs.existsSync(configPath)) {
      logger.warn('airlock.config.json already exists in this directory');
      return;
    }

    const sampleConfig = {
      projectName: 'Acme SaaS Airlock QA',
      baseUrl: 'http://localhost:3900',
      browser: {
        headless: true,
        viewport: { width: 1280, height: 800 },
      },
      proxy: {
        enabled: true,
        port: 8899,
      },
      secrets: {
        STRIPE_SECRET_KEY: {
          // The real value is read from this environment variable at load time.
          realFromEnv: 'STRIPE_SECRET_KEY',
          real: 'REPLACE_ME_STRIPE_SECRET_KEY',
          phantom: 'ph_sec_stripe_test_8f2a1c',
          allowedHosts: ['localhost', '127.0.0.1', 'api.stripe.com'],
          allowedMethods: ['GET', 'POST'],
          blockedPaths: ['*/refunds*', '*/wipe*', '*/transfers*'],
        },
        ADMIN_AUTH_TOKEN: {
          realFromEnv: 'ADMIN_AUTH_TOKEN',
          real: 'REPLACE_ME_ADMIN_AUTH_TOKEN',
          phantom: 'ph_auth_bearer_9901_admin',
          allowedHosts: ['localhost', '127.0.0.1'],
          blockedPaths: ['/api/admin/wipe-data'],
        },
      },
      policy: {
        defaultAction: 'BLOCK',
        allowedEgressHosts: ['127.0.0.1', 'localhost', 'api.stripe.com'],
        blockedEgressHosts: ['pastebin.com', 'webhook.site', 'transfer.sh'],
        rules: [
          {
            id: 'block-destructive-refunds',
            description: 'Prevent accidental refunds or wipes during test runs',
            hostPattern: '*',
            blockedPaths: ['*/refunds*', '*/wipe*', '*/delete-all*'],
            action: 'BLOCK',
          },
          {
            id: 'allow-safe-charges',
            description: 'Allow test charge creation',
            hostPattern: 'api.stripe.com',
            allowedPaths: ['/v1/charges', '/v1/customers'],
            action: 'ALLOW',
          },
        ],
        logPayloads: true,
      },
      compiler: {
        outputDir: './examples/tests',
        defaultTimeoutMs: 10000,
        emitAriaFallbacks: true,
      },
      healer: {
        autoHeal: true,
        confidenceThreshold: 0.8,
        datasetDir: './.airlock/dataset',
        saveMutations: true,
      },
      forker: {
        checkpointsDir: './.airlock/checkpoints',
        maxParallelForks: 5,
      },
      // signingKey is intentionally left unset; supply it via config or environment (see docs).
      compliance: {
        outputDir: './.airlock/compliance',
        generateHtmlReport: true,
      },
    };

    writeJsonFile(configPath, sampleConfig);
    ensureDir('./.airlock/checkpoints');
    ensureDir('./.airlock/compliance');
    ensureDir('./.airlock/dataset');
    ensureDir('./.airlock/traces');
    ensureDir('./examples/tests');

    logger.success('Initialized AirlockQA workspace successfully: airlock.config.json created');
  });

// ==========================================
// COMMAND: EXPLORE
// ==========================================
program
  .command('explore [url]')
  .description('Open a browser and record your clicks, typing, key presses and selections into a trace')
  .option('-n, --name <name>', 'Suite name for the trace (default: derived from the URL host)')
  .option('-o, --out <path>', 'Trace output path (default: .airlock/traces/<name>-trace.json)')
  .option('--output <path>', 'Alias for --out')
  .option('--headless', 'Record without a visible window (for scripted sessions)')
  .action(async (urlArg, opts) => {
    logger.banner();
    const config = loadConfig();
    const targetUrl = urlArg || config.baseUrl;
    const suiteName = opts.name || suiteNameFromUrl(targetUrl);
    const tracePath = path.resolve(process.cwd(), opts.out || opts.output || `.airlock/traces/${suiteName}-trace.json`);

    logger.moat(2, 'Recording Session', `Opening ${targetUrl}. Use the browser; close the window or press Ctrl+C here to save the trace.`);

    const browser = await chromium.launch({
      executablePath: config.browser?.executablePath,
      headless: Boolean(opts.headless),
      // Keep the browser alive on Ctrl+C so pending input can be flushed before saving.
      handleSIGINT: false,
      handleSIGTERM: false,
    });
    const context = await browser.newContext({ viewport: config.browser?.viewport });
    const trace = new TraceRecorder(suiteName, targetUrl);
    const recorder = new InteractionRecorder(trace);
    await recorder.attach(context);

    const finished = new Promise<string>((resolve) => {
      const onPageClose = () => {
        if (context.pages().every((p) => p.isClosed())) resolve('all browser windows closed');
      };
      context.on('page', (p) => p.on('close', onPageClose));
      context.on('close', () => resolve('browser context closed'));
      browser.on('disconnected', () => resolve('browser closed'));
      process.once('SIGINT', () => resolve('Ctrl+C'));
      process.once('SIGTERM', () => resolve('SIGTERM'));
    });

    const page = await context.newPage();
    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    } catch (err) {
      logger.error(`Could not open ${targetUrl}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
      process.exitCode = 1;
      await browser.close().catch(() => {});
      return;
    }

    const reason = await finished;
    await recorder.flush(context);
    await browser.close().catch(() => {});

    const recorded = trace.getTrace();
    writeJsonFile(tracePath, recorded);
    const actions = recorded.steps.filter((s) => s.type !== 'goto').length;
    logger.success(`Recording stopped (${reason}). Saved ${recorded.steps.length} steps (${actions} interactions) to ${tracePath}`);
    if (recorded.steps.some((s) => s.value === REDACTED_VALUE)) {
      logger.warn('Password fields were recorded as a placeholder. Replace it before running the compiled spec.');
    }
    if (actions === 0) {
      logger.warn('No interactions were captured.');
    } else {
      logger.info(`Next: airlock compile ${path.relative(process.cwd(), tracePath)}`);
    }
    process.exit(process.exitCode ?? 0);
  });

// ==========================================
// COMMAND: COMPILE
// ==========================================
program
  .command('compile <tracePath>')
  .description('Compile a recorded trace into a Playwright spec')
  .option('-o, --out <path>', 'Output spec file path')
  .option('--output <path>', 'Alias for --out')
  .action((tracePath, opts) => {
    logger.banner();
    const config = loadConfig();
    const resolvedTracePath = path.resolve(process.cwd(), tracePath);
    if (!fs.existsSync(resolvedTracePath)) {
      logger.error(`Trace file not found: ${resolvedTracePath}`);
      process.exitCode = 1;
      return;
    }

    let trace: ExecutionTrace;
    try {
      trace = readJsonFile<ExecutionTrace>(resolvedTracePath);
      if (!trace || !Array.isArray(trace.steps) || typeof trace.suiteName !== 'string') {
        throw new Error('expected a trace object with "suiteName" and "steps"');
      }
    } catch (err) {
      logger.error(`Could not read trace ${resolvedTracePath}: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }

    try {
      const compiler = new AstGenerator();
      const compiledCode = compiler.compileToSpec(trace, {
        suiteTitle: trace.suiteName,
        defaultTimeoutMs: config.compiler?.defaultTimeoutMs,
        includeAriaFallbacks: config.compiler?.emitAriaFallbacks,
      });

      const outOption = opts.out || opts.output;
      const outDir = config.compiler?.outputDir || './tests/generated';
      const outPath = outOption ? path.resolve(process.cwd(), outOption) : path.resolve(process.cwd(), outDir, `${trace.suiteName}.spec.ts`);
      ensureDir(path.dirname(outPath));
      fs.writeFileSync(outPath, compiledCode, 'utf8');

      logger.success(`Compiled ${trace.steps.length} trace steps to ${outPath}`);
      logger.info(`Run it with: airlock test --local ${path.relative(process.cwd(), outPath)}`);
    } catch (err) {
      logger.error(`Compilation failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

// ==========================================
// COMMAND: TEST (Execution Target Router)
// ==========================================
program
  .command('test [specPath]')
  .description('Run spec files locally with Playwright Test, or submit a run request to Airlock Cloud')
  .option('-l, --local', 'Run locally without submitting to a Cloud API')
  .option('-c, --cloud', 'Submit a run request to Airlock Cloud (requires AIRLOCK_API_KEY)')
  .option('-u, --url <url>', 'Target base URL')
  .option('-s, --suite <name>', 'Suite name sent to Airlock Cloud (default: spec file name, then projectName)')
  .option('-w, --workflow <file>', 'Cloud: JSON file with the workflow to run (default: the config workflow)')
  .option('--no-wait', 'Cloud: submit the run and exit without waiting for the result')
  .option('--timeout <seconds>', 'Cloud: how long to wait for the result', '600')
  .action(async (specPath, opts) => {
    logger.banner();
    try {
      const { ExecutionTargetRouter } = await import('../src/router/execution-router.js');
      const { target, result } = await ExecutionTargetRouter.routeAndExecute({
        local: opts.local,
        cloud: opts.cloud,
        specPath,
        suiteName: opts.suite,
        targetUrl: opts.url,
        workflowFile: opts.workflow,
        wait: opts.wait,
        timeoutSeconds: Number(opts.timeout) || 600,
      });
      if (target === 'LOCAL') {
        const exitCode = (result as LocalTestRunResult).exitCode;
        if (exitCode !== 0) process.exitCode = exitCode;
      } else {
        const status = (result as { status?: string }).status;
        if (status === 'FAILED' || status === 'POLICY_VIOLATION' || status === 'CANCELLED') process.exitCode = 1;
      }
    } catch (error) {
      logger.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

// ==========================================
// COMMAND: RUN
// ==========================================
program
  .command('run [specPath]')
  .description('Run the workflow defined in airlock.config.json (or a spec file) and generate run evidence')
  .option('-u, --url <url>', 'Target base URL')
  .option('-w, --workflow <file>', 'JSON file containing a workflow (instead of the "workflow" key in the config)')
  .action(async (specPath, opts) => {
    logger.banner();
    try {
      const config = loadConfig();
      const targetUrl = opts.url || config.baseUrl;

      if (specPath) {
        const result = await runPlaywrightSpecs({ specPath, targetUrl, config });
        if (result.exitCode !== 0) {
          logger.error(`Spec run failed (${result.passed} passed, ${result.failed} failed)`);
          process.exitCode = result.exitCode;
        } else {
          logger.success(`Spec run passed (${result.passed} passed)`);
        }
        return;
      }

      const workflow = loadWorkflow(opts.workflow);
      if (!workflow) {
        logger.error('No workflow to run. Add a "workflow" section to airlock.config.json, pass --workflow <file>, or pass a spec path.');
        process.exitCode = 1;
        return;
      }

      logger.moat(1, `Running workflow '${workflow.name}'`, `${workflow.steps.length} steps against ${targetUrl}`);
      for (const [name, secret] of Object.entries(config.secrets)) {
        logger.info(`  Secret [${name}]: browser sees placeholder '${secret.phantom}'`);
      }

      const runner = new AirlockRunner(config);
      const browser = await chromium.launch({
        executablePath: config.browser?.executablePath,
        headless: config.browser?.headless,
        slowMo: config.browser?.slowMo || undefined,
      });

      try {
        const context = await browser.newContext({ viewport: config.browser?.viewport });
        const page = await context.newPage();
        await runner.initialize(context, page);

        const result = await executeWorkflow(workflow, { page, context, runner, config, baseUrl: targetUrl });
        const bundle = await runner.finalize();

        const passed = result.steps.filter((s) => s.ok).length;
        if (result.ok) {
          logger.success(`Workflow '${workflow.name}' passed: ${passed}/${workflow.steps.length + (workflow.startUrl ? 1 : 0)} steps`);
        } else {
          const failed = result.steps.find((s) => !s.ok);
          logger.error(`Workflow '${workflow.name}' failed at step ${failed?.index} (${failed?.action}): ${failed?.error}`);
          process.exitCode = 1;
        }
        console.log(runner.generatePRComment(bundle));
      } finally {
        await browser.close();
      }
    } catch (err) {
      logger.error(`Run failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

// ==========================================
// COMMAND: FORK
// ==========================================
program
  .command('fork <checkpointName>')
  .description('Restore a saved checkpoint into parallel browser contexts and try one input value in each')
  .option('-v, --variations <file>', 'JSON file with variations (and optionally inputSelector, actionSelector, expect)')
  .option('--values <list>', 'Comma-separated input values; one variation per value')
  .option('-i, --input <selector>', 'Selector of the field to fill')
  .option('-a, --action <selector>', 'Selector to click after filling')
  .option('--expect-selector <selector>', 'Selector that must be visible after the action (with --expect-text: element whose text is checked)')
  .option('--expect-text <text>', 'Text that must appear after the action')
  .option('-w, --workers <count>', 'Maximum number of variations to run')
  .action(async (checkpointName, opts) => {
    logger.banner();
    try {
      const config = loadConfig();
      const plan = buildForkPlan({
        variationsFile: opts.variations,
        values: opts.values,
        input: opts.input,
        action: opts.action,
        expectSelector: opts.expectSelector,
        expectText: opts.expectText,
        workers: opts.workers ? parseInt(opts.workers, 10) : undefined,
      });

      const runner = new AirlockRunner(config);
      const browser = await chromium.launch({
        executablePath: config.browser?.executablePath,
        headless: config.browser?.headless,
      });

      try {
        const byId = new Map(plan.variations.map((v) => [v.id, v]));
        const timeout = config.compiler?.defaultTimeoutMs ?? 5000;
        const results = await runner.fork(browser, checkpointName, plan.variations, ({ variation, page }) =>
          runForkVariation(page, plan, byId.get(variation.id)!, timeout)
        );

        const failed = results.filter((r) => !r.success);
        for (const r of results) {
          const line = `${r.variationId}: ${r.assertionsPassed}/${r.assertionsTotal} checks passed${r.error ? ` (${r.error})` : ''}`;
          if (r.success) logger.success(line);
          else logger.error(line);
        }
        if (failed.length > 0) {
          logger.error(`${failed.length} of ${results.length} variations failed`);
          process.exitCode = 1;
        } else {
          logger.success(`All ${results.length} variations passed`);
        }
      } finally {
        await browser.close();
      }
    } catch (err) {
      logger.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

// ==========================================
// COMMAND: AUDIT
// ==========================================
program
  .command('audit [bundlePath]')
  .description('Verify a signed run-evidence bundle (hash chain, Merkle root and signature). Not a compliance assessment.')
  .action(async (bundlePathArg) => {
    const { resolveSigningKey, warnDevSigningKey } = await import('../src/compliance/attestation.js');
    logger.banner();
    const config = loadConfig();
    const targetPath = bundlePathArg
      ? path.resolve(process.cwd(), bundlePathArg)
      : path.resolve(process.cwd(), config.compliance?.outputDir || './.airlock/compliance', 'latest-attestation.json');

    if (!fs.existsSync(targetPath)) {
      logger.error(`Evidence bundle not found at: ${targetPath}`);
      process.exit(1);
    }

    let bundle: ComplianceProofBundle;
    try {
      bundle = readJsonFile<ComplianceProofBundle>(targetPath);
    } catch (err) {
      logger.error(`Cannot read evidence bundle: ${(err as Error).message}`);
      process.exit(1);
    }

    const shown = (v: unknown) => (v === null || v === undefined ? 'not measured' : String(v));
    logger.moat(4, 'Verifying signed run-evidence bundle');
    logger.info(`File: ${targetPath}`);
    logger.info(`Spec version: ${shown(bundle.specVersion)}`);
    logger.info(`Run ID: ${shown(bundle.runId)}`);
    logger.info(`Signing: ${shown(bundle.signingAlgorithm)} (key ${shown(bundle.publicKeyOrKeyId)})`);
    logger.info(`Merkle root: ${shown(bundle.merkleRoot)}`);

    // HMAC needs the shared secret. For Ed25519 the configured key (or AIRLOCK_TRUSTED_PUBLIC_KEY) pins the signer.
    let verifyKey: string | undefined;
    const trustedPublicKey = process.env.AIRLOCK_TRUSTED_PUBLIC_KEY || undefined;
    try {
      const signing = resolveSigningKey(config.compliance?.signingKey);
      if (signing.isDevKey) {
        warnDevSigningKey();
        // Only an HMAC dev bundle can be checked with the dev key; never pin Ed25519 to it.
        verifyKey = bundle.signingAlgorithm === 'HMAC-SHA256' ? signing.key : undefined;
      } else {
        verifyKey = signing.key;
      }
    } catch (err) {
      if (bundle.signingAlgorithm !== 'Ed25519' || !trustedPublicKey) {
        logger.error((err as Error).message);
        process.exit(1);
      }
    }

    const result = AttestationEngine.verifyBundle(bundle, { key: verifyKey, trustedPublicKey });
    if (!result.valid) {
      logger.error(`VERIFICATION FAILED: ${result.reason}`);
      process.exit(1);
    }

    logger.success('Signature, hash chain and Merkle root verified');
    logger.info(`  ├─ Ledger blocks: ${bundle.blocksCount} (chain recomputed: ${bundle.ledgerVerificationStatus})`);
    logger.info(`  ├─ Steps dispatched: ${shown(bundle.summary.totalSteps)} | passed: ${shown(bundle.summary.passedSteps)} | failed: ${shown(bundle.summary.failedSteps)}`);
    logger.info(`  ├─ Duration: ${bundle.summary.durationMs == null ? 'not measured' : `${bundle.summary.durationMs}ms`} | AI token cost: ${shown(bundle.summary.aiTokenCostUsd)}`);
    logger.info(`  ├─ Requests blocked: ${shown(bundle.policyAudit.egressBlockedCount)} | allowed: ${shown(bundle.policyAudit.egressAllowedCount)} | mutations blocked: ${shown(bundle.policyAudit.unauthorizedMutationsPrevented)}`);
    logger.info(`  ├─ Phantom tokens configured: ${shown(bundle.policyAudit.phantomTokensConfigured)} | real secrets exposed to sandbox: ${shown(bundle.policyAudit.realSecretsExposedToSandbox)}`);
    logger.info(
      `  └─ SOC 2 mapping: CC6.1 ${shown(bundle.soc2Mapping.cc6_1_logicalAccess)}, CC6.6 ${shown(bundle.soc2Mapping.cc6_6_boundaryProtection)}, ` +
        `CC7.1 ${shown(bundle.soc2Mapping.cc7_1_changeVerification)}, CC8.1 ${shown(bundle.soc2Mapping.cc8_1_nonRepudiation)}`
    );
    for (const warning of result.warnings) logger.warn(warning);
    logger.info('This bundle is signed run evidence, not a compliance assessment.');
  });

// ==========================================
// COMMAND: DATASET
// ==========================================
program
  .command('dataset')
  .description('Inspect compounding failure dataset statistics and logged UI mutation patches')
  .action(() => {
    logger.banner();
    const config = loadConfig();
    const collector = new DatasetCollector(config.healer?.datasetDir);
    const stats = collector.getStats();

    logger.moat(2, 'Selector Failure Dataset');
    console.log(`Total UI Mutation Tuples Logged: ${stats.totalMutations}`);
    console.log(`Average Heuristic Match Confidence: ${(stats.avgConfidence * 100).toFixed(1)}%`);
    console.log('Resolution Strategies:');
    for (const [m, c] of Object.entries(stats.methodsBreakdown)) {
      console.log(`  - ${m}: ${c}`);
    }
    console.log('Detected UI Frameworks:');
    for (const [fw, c] of Object.entries(stats.frameworksBreakdown)) {
      console.log(`  - ${fw}: ${c}`);
    }
  });

// ==========================================
// COMMAND: SERVE
// ==========================================
program
  .command('serve')
  .description('Start interactive Web Dashboard and Compliance Audit Console')
  .option('-p, --port <port>', 'Dashboard server port', '4100')
  .action((opts) => {
    logger.banner();
    const config = loadConfig();
    const port = parseInt(opts.port, 10);
    startDashboardServer(config, port);
  });

// ==========================================
// COMMAND: WARP (Virtual Time-Warp)
// ==========================================
program
  .command('warp <duration>')
  .description('Preview a browser-page Date offset (e.g. "+14 days", "+1 hour"); runs with no page, so it only computes the offset and changes no clock')
  .action(async (duration) => {
    logger.banner();
    const { TimeWarper } = await import('../src/timewarp/time-warper.js');
    const warper = new TimeWarper();
    const result = await warper.warp(duration);
    logger.moat(1, 'Browser Date Offset Computed (no page attached, nothing was changed)');
    console.log(`Previous Time: ${result.previousTimeIso}`);
    console.log(`Advanced Time: ${result.targetTimeIso}`);
    console.log(`Delta:         ${result.deltaMs > 0 ? '+' : ''}${(result.deltaMs / 1000 / 3600 / 24).toFixed(2)} days (${result.durationString})`);
    console.log(`Scope:         ${result.scope} (only a browser page's new Date() and Date.now() can be offset; timers, the system clock and services are not affected)`);
  });

// ==========================================
// COMMAND: CHAOS (Mutation observer)
// ==========================================
program
  .command('chaos [url]')
  .description('Trigger one mutation (e.g. a checkout) and report whether it carries an idempotency key')
  .option('-a, --action <selector>', 'Selector of the element that triggers the mutation')
  .option('-e, --endpoint <regex>', 'Regular expression matching the mutation request URL')
  .option('-f, --file <json>', 'JSON file: { "url"?, "actionSelector", "endpointPattern"?, "setup"?: [workflow steps] }')
  .action(async (urlArg, opts) => {
    logger.banner();
    try {
      const config = loadConfig();
      const fileOpts = opts.file ? loadChaosFile(opts.file) : {};
      const targetUrl = urlArg || fileOpts.url || config.baseUrl;
      const actionSelector: string | undefined = opts.action || fileOpts.actionSelector;
      const endpointPattern: string | undefined = opts.endpoint || fileOpts.endpointPattern;
      if (!actionSelector) {
        throw new Error('No action selector. Pass --action <selector> or set "actionSelector" in --file.');
      }

      const { ChaosHunter } = await import('../src/chaos/chaos-hunter.js');
      const hunter = new ChaosHunter();
      const runner = new AirlockRunner(config);
      const browser = await chromium.launch({
        executablePath: config.browser?.executablePath,
        headless: config.browser?.headless,
      });
      try {
        const context = await browser.newContext({ viewport: config.browser?.viewport });
        const page = await context.newPage();
        await runner.initialize(context, page);
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });

        if (fileOpts.setup?.length) {
          const setup = await executeWorkflow(
            { name: 'chaos-setup', steps: fileOpts.setup },
            { page, context, runner, config, baseUrl: targetUrl }
          );
          if (!setup.ok) throw new Error('Setup steps failed; mutation was not triggered.');
        }

        let actionError: string | undefined;
        const timeout = config.compiler?.defaultTimeoutMs ?? 5000;
        const report = await hunter.auditMutation(
          page,
          async () => {
            try {
              await page.locator(actionSelector).click({ timeout });
              await page.waitForLoadState('networkidle', { timeout }).catch(() => {});
            } catch (err) {
              actionError = err instanceof Error ? err.message.split('\n')[0] : String(err);
              throw err;
            }
          },
          endpointPattern ? { endpointPattern: new RegExp(endpointPattern) } : {}
        );
        console.log(ChaosHunter.formatReport(report));

        if (actionError) {
          logger.error(`Could not trigger the mutation: ${actionError}`);
          process.exitCode = 1;
        } else if (!report.targetEndpoint) {
          logger.error('No matching mutation request was observed. Check --action and --endpoint.');
          process.exitCode = 1;
        } else if (report.status === 'RISK_INDICATED') {
          logger.error(`FAIL: ${report.targetEndpoint} was sent without an idempotency key.`);
          process.exitCode = 1;
        } else {
          logger.success(`PASS: ${report.targetEndpoint} carried an idempotency key.`);
        }
      } finally {
        await browser.close();
      }
    } catch (err) {
      logger.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

// ==========================================
// COMMAND: TELEPORT (Bug Rehydration & Spec Synthesis)
// ==========================================
program
  .command('teleport <capsulePath>')
  .description('Synthesize a Playwright repro spec from a browser-state capsule')
  .option('-o, --out <outPath>', 'Destination repro spec file')
  .option('--output <outPath>', 'Alias for --out')
  .action(async (capsulePath, opts) => {
    logger.banner();
    const fullPath = path.resolve(process.cwd(), capsulePath);
    if (!fs.existsSync(fullPath)) {
      logger.error(`Capsule file not found: ${fullPath}`);
      process.exitCode = 1;
      return;
    }
    try {
      const { CapsuleManager } = await import('../src/teleport/capsule.js');
      const capsule = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      const spec = CapsuleManager.synthesizeReproSpec(capsule);
      const config = loadConfig();
      const outPath = path.resolve(
        process.cwd(),
        opts.out || opts.output || path.join(config.compiler?.outputDir || './tests/generated', `repro-${capsule.capsuleId}.spec.ts`)
      );
      ensureDir(path.dirname(outPath));
      fs.writeFileSync(outPath, spec, 'utf8');
      logger.success(`Reproduction spec synthesized: ${outPath}`);
    } catch (err) {
      logger.error(`Could not synthesize a repro spec from ${fullPath}: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

function suiteNameFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
    return host ? `explore-${host}` : 'explore';
  } catch {
    return 'explore';
  }
}

const ChaosFileSchema = z.object({
  url: z.string().optional(),
  actionSelector: z.string().min(1).optional(),
  endpointPattern: z.string().optional(),
  setup: z.array(WorkflowStepSchema).optional(),
});

function loadChaosFile(file: string): z.infer<typeof ChaosFileSchema> {
  const full = path.resolve(process.cwd(), file);
  if (!fs.existsSync(full)) throw new Error(`Chaos file not found: ${full}`);
  const parsed = ChaosFileSchema.safeParse(JSON.parse(fs.readFileSync(full, 'utf8')));
  if (!parsed.success) {
    throw new Error(`Invalid chaos file ${full}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
  }
  return parsed.data;
}


// ==========================================
// COMMANDS: AIRLOCK CLOUD ACCOUNT (login, logout, whoami, usage, runs)
// ==========================================
function cloudAction(handler: () => Promise<void> | void): () => Promise<void> {
  return async () => {
    try {
      await handler();
    } catch (error) {
      logger.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  };
}

program
  .command('login')
  .description('Save an Airlock Cloud API key on this machine (create one in the console under CI/CD & API)')
  .option('--key <key>', 'API key (prefer the hidden prompt or AIRLOCK_API_KEY; command-line values land in shell history)')
  .option('--api-url <url>', 'Airlock Cloud API base URL (default: AIRLOCK_CLOUD_URL or https://api.qbrin.cloud)')
  .action((opts) => cloudAction(async () => (await import('../src/router/cloud-commands.js')).loginCommand({ key: opts.key, apiUrl: opts.apiUrl }))());

program
  .command('logout')
  .description('Remove the saved Airlock Cloud API key from this machine')
  .action(() => cloudAction(async () => (await import('../src/router/cloud-commands.js')).logoutCommand())());

program
  .command('whoami')
  .description('Show which Airlock Cloud key and plan this machine uses')
  .option('--api-url <url>', 'Airlock Cloud API base URL')
  .action((opts) => cloudAction(async () => (await import('../src/router/cloud-commands.js')).whoamiCommand({ apiUrl: opts.apiUrl }))());

program
  .command('usage')
  .description('Show today\'s Airlock Cloud run usage and limits')
  .option('--json', 'Print the raw JSON')
  .option('--api-url <url>', 'Airlock Cloud API base URL')
  .action((opts) => cloudAction(async () => (await import('../src/router/cloud-commands.js')).usageCommand({ json: opts.json, apiUrl: opts.apiUrl }))());

program
  .command('runs [runId]')
  .description('List recent Airlock Cloud runs, or show one run with its steps')
  .option('-n, --limit <count>', 'How many runs to list (max 100)', '20')
  .option('--status <status>', 'Only list runs with this status (for example FAILED)')
  .option('--json', 'Print the raw JSON')
  .option('--api-url <url>', 'Airlock Cloud API base URL')
  .action((runId, opts) =>
    cloudAction(async () =>
      (await import('../src/router/cloud-commands.js')).runsCommand(runId, { limit: opts.limit, status: opts.status, json: opts.json, apiUrl: opts.apiUrl })
    )()
  );

// ==========================================
// COMMAND: QA (cloud QA runs; --dry-run only until the submit route exists)
// ==========================================
const qa = program
  .command('qa')
  .description('Run QA on the pushed commit in Airlock Cloud. --dry-run prints the request without submitting it; --wait waits for the gate verdict.')
  .option('--dry-run', 'print the request that would be submitted, submit nothing')
  .option('--suites <list>', 'comma-separated suites (unit,integration,e2e,smoke,explore,a11y,security,load)', 'unit')
  .option('--gate <mode>', 'strict or default', 'default')
  .option('--continue-on-failure', 'still run a11y, security, load and explore after a failing test suite (build, start and smoke still stop the run)')
  .option('--repo <url>', 'public GitHub repository URL to test (CI; default: the origin remote)')
  .option('--sha <sha>', 'full commit SHA to test (CI; default: HEAD)')
  .option('--branch <name>', 'branch name to record with the run (CI)')
  .option('--json', 'print machine-readable JSON (for CI); suppress progress lines')
  .option('--wait', 'wait for the run to finish and exit 0 only if the gate passed')
  .action(async (opts) => {
    const { prepareQaDryRun, realQaDeps } = await import('../src/router/qa-cli.js');
    const suites = String(opts.suites).split(',').map((x: string) => x.trim()).filter(Boolean);
    const gate = opts.gate === 'strict' ? 'strict' : 'default';
    const result = await prepareQaDryRun(
      {
        suites,
        gate,
        continueOnFailure: opts.continueOnFailure === true,
        ...(opts.repo ? { repo: opts.repo } : {}),
        ...(opts.sha ? { sha: opts.sha } : {}),
        ...(opts.branch ? { branch: opts.branch } : {}),
      },
      realQaDeps()
    );
    if (!result.ok) {
      logger.error(result.message);
      process.exitCode = 1;
      return;
    }
    if (!opts.json) for (const w of result.warnings) logger.warn(w);
    if (opts.dryRun) {
      console.log(JSON.stringify(result.body, null, 2));
      return;
    }
    const { resolveCloudAuth } = await import('../src/router/cloud-credentials.js');
    const { submitQaRun, waitForQaRun } = await import('../src/router/qa-cli.js');
    const auth = resolveCloudAuth({});
    if (!auth) {
      logger.error('Not signed in. Run "airlock login" (or set AIRLOCK_API_KEY) to submit a QA run.');
      process.exitCode = 1;
      return;
    }
    const target = { apiUrl: auth.apiUrl, apiKey: auth.apiKey };
    const submitted = await submitQaRun(result.body, target);
    if (!opts.json) logger.info(`QA run ${submitted.id} queued for ${result.body.repo}@${result.body.sha.slice(0, 7)}`);
    if (!opts.wait) {
      if (opts.json) console.log(JSON.stringify({ id: submitted.id, status: submitted.status }));
      return;
    }
    const run = await waitForQaRun(target, submitted.id, { intervalMs: 15_000, timeoutMs: 75 * 60_000 });
    const { verifyQaSeal } = await import('../src/router/qa-cli.js');
    const sealed = (run as { evidence?: unknown }).evidence;
    const sealVerified = verifyQaSeal(sealed);
    if (opts.json) console.log(JSON.stringify({ id: submitted.id, run, sealVerified }));
    else {
      console.log(JSON.stringify(run, null, 2));
      logger.info(sealVerified ? 'Sealed result: signature verified with the service key' : 'Sealed result: NOT verified (missing or altered)');
    }
    process.exitCode = run.status === 'SUCCESS' && run.gate?.exitCode === 0 && sealVerified ? 0 : 1;
  });

qa
  .command('report <runId>')
  .description('Download a QA run (findings, screenshots) and write a report; optionally comment on or open a PR')
  .option('--out <dir>', 'where to write report.md and screenshots/ (default: qa-reports/<runId>)')
  .option('--pr <number>', 'post the report as a comment on this pull request')
  .option('--repo <owner/repo>', 'GitHub repository for --pr or --create-pr (default: the current repository)')
  .option('--create-pr', 'commit the report to a branch and open a pull request in the current repository')
  .option('--title <title>', 'title for --create-pr')
  .option('--api-url <url>', 'Airlock Cloud API base URL')
  .action((runId: string, opts) =>
    cloudAction(async () => (await import('../src/qa/report-command.js')).qaReportCommand(runId, opts))()
  );

// ==========================================
// COMMAND: SYNC (encrypted local artifacts to the account)
// ==========================================
const sync = program
  .command('sync')
  .description('Upload traces, checkpoints, healing logs, fixtures and capsules to your Airlock Cloud account, encrypted on this machine')
  .option('--kind <list>', 'comma-separated: trace,checkpoint,healing,fixtures,capsule', 'trace,checkpoint,healing,fixtures,capsule')
  .option('--dry-run', 'list what would be uploaded, send nothing')
  .option('--json', 'print JSON')
  .option('--api-url <url>', 'Airlock Cloud API base URL')
  .action((opts) =>
    cloudAction(async () => {
      const { resolveCloudAuth } = await import('../src/router/cloud-credentials.js');
      const { syncKeyFromEnv, uploadLocalArtifacts, SYNC_KINDS } = await import('../src/router/sync-command.js');
      const auth = resolveCloudAuth({ apiUrl: opts.apiUrl });
      if (!auth) throw new Error('Not signed in. Run "airlock login" (or set AIRLOCK_API_KEY) first.');
      const kinds = String(opts.kind).split(',').map((value: string) => value.trim()).filter(Boolean);
      for (const kind of kinds) if (!(SYNC_KINDS as readonly string[]).includes(kind)) throw new Error(`unknown sync kind: ${kind}`);
      const key = opts.dryRun ? undefined : syncKeyFromEnv();
      const result = await uploadLocalArtifacts(
        { apiUrl: auth.apiUrl, apiKey: auth.apiKey },
        process.cwd(),
        key || '',
        kinds as any,
        { dryRun: opts.dryRun === true, log: opts.json ? () => undefined : undefined }
      );
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      else logger.info(`Synced ${result.uploaded} artifact${result.uploaded === 1 ? '' : 's'}${result.skipped ? `, skipped ${result.skipped}` : ''}.`);
    })()
  );

sync
  .command('list')
  .description('List synced local artifacts for this account')
  .option('--limit <n>', '1 to 100', '50')
  .option('--json', 'print JSON')
  .option('--api-url <url>', 'Airlock Cloud API base URL')
  .action((opts) =>
    cloudAction(async () => {
      const { resolveCloudAuth } = await import('../src/router/cloud-credentials.js');
      const { listSyncArtifacts } = await import('../src/router/sync-command.js');
      const auth = resolveCloudAuth({ apiUrl: opts.apiUrl });
      if (!auth) throw new Error('Not signed in. Run "airlock login" (or set AIRLOCK_API_KEY) first.');
      const artifacts = await listSyncArtifacts({ apiUrl: auth.apiUrl, apiKey: auth.apiKey }, Number(opts.limit) || 50);
      // Commander's parent sync command also declares --json; use the raw argv as a fallback so
      // `sync list --json` means JSON regardless of which command object parsed the flag.
      const asJson = opts.json === true || process.argv.includes('--json');
      if (asJson) console.log(JSON.stringify({ artifacts }, null, 2));
      else if (artifacts.length === 0) console.log('No synced artifacts yet.');
      else for (const a of artifacts) console.log(`${a.id}  ${a.kind.padEnd(10)}  ${String(a.plaintextSize).padStart(8)} B  ${a.name}`);
    })()
  );

sync
  .command('download <id>')
  .description('Download and decrypt one synced artifact')
  .option('--out <file>', 'where to write the decrypted file')
  .option('--api-url <url>', 'Airlock Cloud API base URL')
  .action((id: string, opts) =>
    cloudAction(async () => {
      const { resolveCloudAuth } = await import('../src/router/cloud-credentials.js');
      const { syncKeyFromEnv, downloadSyncArtifact } = await import('../src/router/sync-command.js');
      if (!opts.out) throw new Error('--out is required');
      const auth = resolveCloudAuth({ apiUrl: opts.apiUrl });
      if (!auth) throw new Error('Not signed in. Run "airlock login" (or set AIRLOCK_API_KEY) first.');
      await downloadSyncArtifact({ apiUrl: auth.apiUrl, apiKey: auth.apiKey }, id, syncKeyFromEnv(), opts.out);
    })()
  );

// ==========================================
// COMMAND: AI (a coding agent already signed in on this machine; no API key)
// ==========================================
const ai = program
  .command('ai')
  .description('Use a local coding agent (Claude Code, Antigravity, Codex or Gemini CLI) for AI help, with no API key');

ai.command('doctor')
  .description('Show which local agents are installed; --probe also checks that each one answers')
  .option('--probe', 'send each installed agent a one-word prompt')
  .option('--json', 'print JSON')
  .action((opts) => cloudAction(async () => (await import('../src/ai/commands.js')).aiDoctorCommand({ probe: opts.probe, json: opts.json }))());

ai.command('ask <question...>')
  .description('Ask the local agent a question (it runs read-only, in an empty folder)')
  .option('--agent <name>', 'auto, claude, agy (Antigravity), codex or gemini (default: AIRLOCK_AGENT or auto)')
  .option('--model <model>', 'model name passed to the agent')
  .action((question: string[], opts) =>
    cloudAction(async () => (await import('../src/ai/commands.js')).aiAskCommand(question.join(' '), { agent: opts.agent, model: opts.model }))()
  );

ai.command('explain <qaRunId>')
  .description('Explain why a cloud QA run failed and suggest the smallest fix ("latest" = most recent failed run)')
  .option('--agent <name>', 'auto, claude, agy (Antigravity), codex or gemini (default: AIRLOCK_AGENT or auto)')
  .option('--model <model>', 'model name passed to the agent')
  .option('--show-prompt', 'print the prompt that would be sent, and send nothing')
  .option('--api-url <url>', 'Airlock Cloud API base URL')
  .action((qaRunId: string, opts) =>
    cloudAction(async () =>
      (await import('../src/ai/commands.js')).aiExplainCommand(qaRunId, { agent: opts.agent, model: opts.model, showPrompt: opts.showPrompt, apiUrl: opts.apiUrl })
    )()
  );

// COMMAND: ATTACH (P0 — existing Playwright suites)
// ==========================================
interface AttachCommandOptions {
  config?: string;
  reporterModule?: string;
  outputDir?: string;
  force?: boolean;
  dryRun?: boolean;
  json?: boolean;
  determinism?: boolean;
}

/** In a repo checkout, use the TypeScript reporter directly; installed packages use the compiled path. */
function localReporterModule(): string | undefined {
  try {
    const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
    const candidate = path.join(repoRoot, 'src/testing/airlock-reporter.ts');
    return fs.existsSync(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

program
  .command('attach [projectDir]')
  .description('Attach the Airlock reporter to an existing Playwright suite without editing its specs (writes a safe wrapper config)')
  .option('--config <path>', 'Explicit playwright.config.* path (defaults to auto-detect in projectDir)')
  .option('--reporter-module <module>', 'Reporter module specifier or absolute path (defaults to the local/installed Airlock reporter)')
  .option('--output-dir <dir>', 'Directory for reporter manifests (default: .airlock/reports)')
  .option('--force', 'Replace an existing .airlock/playwright.airlock.config.ts')
  .option('--dry-run', 'Print the plan without writing the wrapper config')
  .option('--determinism', 'Also generate network record/replay + fixed-clock fixtures via a tsconfig path alias (no spec changes)')
  .option('--json', 'Print the attach plan as JSON (machine-readable stdout)')
  .action(async (projectDirArg: string | undefined, opts: AttachCommandOptions) => {
    const { planAttach, writeAttachPlan } = await import('../src/attach/index.js');
    if (!opts.json) logger.banner();
    const projectDir = path.resolve(process.cwd(), projectDirArg || '.');
    try {
      const reporterModule = opts.reporterModule || localReporterModule();
      const plan = planAttach({
        projectDir,
        configPath: opts.config,
        reporterModule,
        outputDir: opts.outputDir,
        determinism: opts.determinism === true,
      });
      const written = opts.dryRun ? [] : writeAttachPlan(plan, { force: opts.force === true });
      if (opts.json) {
        process.stdout.write(
          JSON.stringify(
            {
              projectDir: plan.projectDir,
              configPath: plan.configPath,
              wrapperPath: plan.wrapperPath,
              reporterModule: plan.reporterModule,
              outputDir: plan.outputDir,
              determinism: plan.determinism,
              files: plan.files.map((file) => file.path),
              written,
              dryRun: opts.dryRun === true,
              instructions: plan.instructions,
            },
            null,
            2
          ) + '\n'
        );
        return;
      }
      logger.info(`Found Playwright config: ${plan.configPath}`);
      if (written.length) {
        logger.success(`Wrote ${written.length} attach file(s):`);
        for (const file of written) logger.info(`  ${file}`);
      } else {
        logger.info('Dry run: no files written. Re-run without --dry-run to write the wrapper.');
      }
      logger.info('');
      logger.info('Next steps:');
      for (const line of plan.instructions) logger.info(`  • ${line}`);
      logger.info('');
      logger.info('Then: airlock flake .airlock/reports');
      if (plan.determinism) {
        logger.info('');
        logger.info('Determinism: seed network once with AIRLOCK_ATTACH_NETWORK=record, commit .airlock/network, then run CI with AIRLOCK_ATTACH_NETWORK=replay.');
      }
    } catch (error) {
      logger.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// ==========================================

// COMMAND: FLAKE (P0 — triage attach manifests)
// ==========================================
interface FlakeCommandOptions {
  json?: boolean;
  markdown?: boolean;
  minRuns?: string;
  threshold?: string;
  ownerMap?: string;
  quarantine?: string;
  failOnFlake?: boolean;
  ledgerDir?: string;
}

function renderFlakeTerminal(analysis: {
  generatedAt: string;
  reports: number;
  totalTests: number;
  flakyTests: number;
  totals: Record<string, number>;
  tests: Array<{ title: string; file: string; runs: number; flakeCount: number; classification: string; confidence: string; owner?: string; quarantined: boolean; evidenceTier?: string; ledger?: { requests: number; failures: number; missing: number } }>;
  quarantine: Array<{ title: string; classification: string; owner?: string }>;
  warnings: string[];
}): string {
  const lines: string[] = [];
  lines.push(`Flake analysis — ${analysis.reports} report(s), ${analysis.totalTests} test(s), ${analysis.flakyTests} flaky`);
  lines.push('');
  const causes = Object.entries(analysis.totals).filter(([, count]) => count > 0);
  if (causes.length) lines.push('Probable causes: ' + causes.map(([name, count]) => `${name} ${count}`).join(' · '));
  lines.push('');
  const rows = analysis.tests.filter((test) => test.flakeCount > 0 || test.quarantined);
  if (rows.length) {
    lines.push('Test                                     File                              Runs  Flakes  Cause            Conf    Owner        Quarantine');
    lines.push('─'.repeat(126));
    for (const test of rows) {
      const title = test.title.length > 40 ? test.title.slice(0, 37) + '…' : test.title.padEnd(40);
      const file = test.file.length > 32 ? '…' + test.file.slice(-31) : test.file.padEnd(32);
      lines.push(
        `${title} ${file} ${String(test.runs).padStart(4)} ${String(test.flakeCount).padStart(7)}  ${test.classification.padEnd(16)} ${test.confidence.padEnd(7)} ${(test.owner || '—').padEnd(12)} ${test.quarantined ? 'yes' : 'no'}`
      );
    }
  } else {
    lines.push('No flaky tests in the analyzed reports.');
  }
  const ledgerBacked = analysis.tests.filter(
    (test) => test.evidenceTier === 'request-ledger' && test.ledger !== undefined && (test.ledger.requests > 0 || test.ledger.failures > 0),
  ).length;
  if (ledgerBacked) lines.push('', `Request-ledger evidence: ${ledgerBacked} test(s) backed by recorded traffic (not just error text).`);
  if (analysis.quarantine.length) {
    lines.push('');
    lines.push('Quarantine recommendations (' + analysis.quarantine.length + '):');
    for (const test of analysis.quarantine) lines.push(`  • ${test.title} — ${test.classification}${test.owner ? ` (${test.owner})` : ''}`);
  }
  if (analysis.warnings.length) {
    lines.push('');
    for (const warning of analysis.warnings) lines.push(`warning: ${warning}`);
  }
  lines.push('');
  lines.push('Classification is heuristic from recorded error text. Verify before deleting or quarantining a test.');
  return lines.join('\n');
}

program
  .command('flake [path]')
  .description('Aggregate Airlock reporter manifests and report flaky tests with probable causes, owners and quarantine recommendations')
  .option('--json', 'Print the analysis as JSON (machine-readable stdout)')
  .option('--markdown', 'Print a Markdown report suitable for a PR comment')
  .option('--min-runs <count>', 'Minimum appearances before quarantine is allowed (default 1)')
  .option('--threshold <rate>', 'Quarantine when flake rate is at least this 0..1 (default 0.2)')
  .option('--owner-map <file>', 'JSON map of test id and/or file to owner')
  .option('--quarantine <file>', 'Write quarantine recommendations as JSON')
  .option('--fail-on-flake', 'Exit 1 when any flaky test is found (for CI)')
  .option('--ledger-dir <dir>', 'Request ledgers written by the attach determinism fixture (default: sibling .airlock/ledgers)')
  .action(async (targetPath: string | undefined, opts: FlakeCommandOptions) => {
    if (opts.json) {
      const toStderr = (...args: unknown[]) => console.error(...args);
      console.log = toStderr;
    }
    const { readRunReports } = await import('../src/testing/airlock-report.js');
    const { analyzeFlakiness, renderFlakeMarkdown } = await import('../src/flake/index.js');
    const { ensureDir, writeJsonFile } = await import('../src/utils/files.js');
    if (!opts.json) logger.banner();

    const target = targetPath ? path.resolve(process.cwd(), targetPath) : path.resolve(process.cwd(), '.airlock/reports');
    if (!fs.existsSync(target)) {
      logger.error(`No Airlock reporter manifests at: ${target}`);
      logger.info('Attach the reporter first: airlock attach . — then run your suite with the generated wrapper config.');
      process.exit(1);
    }
    let ownerMap: Record<string, string> | undefined;
    if (opts.ownerMap) {
      const ownerFile = path.resolve(process.cwd(), opts.ownerMap);
      if (!fs.existsSync(ownerFile)) {
        logger.error(`Owner map not found: ${ownerFile}`);
        process.exit(1);
      }
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('owner map must be a JSON object of id/file → owner');
        ownerMap = parsed as Record<string, string>;
      } catch (error) {
        logger.error(`Invalid owner map: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    }

    const reports = readRunReports(target);
    if (!reports.length) {
      logger.error(`No valid Airlock run reports found in: ${target}`);
      logger.info('Run your suite with the reporter first, or pass a file/directory of .airlock/reports/*.json.');
      process.exit(1);
    }
    const minRuns = opts.minRuns === undefined ? undefined : Number(opts.minRuns);
    const threshold = opts.threshold === undefined ? undefined : Number(opts.threshold);
    if (minRuns !== undefined && (!Number.isInteger(minRuns) || minRuns < 1)) {
      logger.error('--min-runs must be a positive integer');
      process.exit(1);
    }
    if (threshold !== undefined && (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)) {
      logger.error('--threshold must be between 0 and 1');
      process.exit(1);
    }

    let analysis = analyzeFlakiness(reports, { minRuns, flakeThreshold: threshold, ownerMap });
    const { readFlakeLedgers, applyLedgerEvidence } = await import('../src/flake/index.js');
    const ledgerDir = opts.ledgerDir
      ? path.resolve(process.cwd(), opts.ledgerDir)
      : path.join(path.dirname(target), 'ledgers');
    const ledgers = readFlakeLedgers(ledgerDir);
    if (ledgers.length) analysis = applyLedgerEvidence(analysis, ledgers);
    if (opts.json) {
      process.stdout.write(JSON.stringify(analysis, null, 2) + '\n');
    } else if (opts.markdown) {
      process.stdout.write(renderFlakeMarkdown(analysis) + '\n');
    } else {
      process.stdout.write(renderFlakeTerminal(analysis) + '\n');
    }

    if (opts.quarantine) {
      const file = path.resolve(process.cwd(), opts.quarantine);
      ensureDir(path.dirname(file));
      writeJsonFile(file, {
        generatedAt: analysis.generatedAt,
        reports: analysis.reports,
        tests: analysis.quarantine.map((test) => ({
          id: test.id,
          title: test.title,
          file: test.file,
          project: test.project,
          classification: test.classification,
          confidence: test.confidence,
          flakeRate: test.flakeRate,
          owner: test.owner,
        })),
      });
      if (!opts.json) logger.info(`Wrote quarantine recommendations: ${file}`);
    }
    if (opts.failOnFlake && analysis.flakyTests > 0) process.exitCode = 1;
  });


// ==========================================

program.parse(process.argv);
