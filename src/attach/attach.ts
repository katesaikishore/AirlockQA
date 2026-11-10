/**
 * Attach path: generate a wrapper Playwright config that adds the Airlock reporter to an existing
 * suite without touching the user's config.
 *
 * `planAttach()` is pure: it detects the project's Playwright config, works out the import
 * specifier the wrapper needs, and renders the wrapper TypeScript. `writeAttachPlan()` is the only
 * function that touches the filesystem; it writes the wrapper plus `.airlock/attach.json` and
 * refuses to overwrite an existing wrapper unless `force` is set. The user's Playwright config is
 * never read beyond its existence and never modified.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/** Playwright config names Playwright itself recognises, in the order we prefer them. */
export const PLAYWRIGHT_CONFIG_CANDIDATES = [
  'playwright.config.ts',
  'playwright.config.js',
  'playwright.config.mts',
  'playwright.config.mjs',
  'playwright.config.cts',
  'playwright.config.cjs',
] as const;

export const AIRLOCK_WRAPPER_RELATIVE_PATH = path.join('.airlock', 'playwright.airlock.config.ts');
export const AIRLOCK_ATTACH_METADATA_RELATIVE_PATH = path.join('.airlock', 'attach.json');
export const DEFAULT_ATTACH_OUTPUT_DIR = '.airlock/reports';
export const FALLBACK_PACKAGE_NAME = 'airlockqa';
export const REPORTER_ENTRY = 'dist/src/testing/airlock-reporter.js';

export interface AttachOptions {
  /** Root of the Playwright project (where playwright.config.* lives). */
  projectDir: string;
  /** Explicit config path, absolute or relative to projectDir. Must resolve inside projectDir. */
  configPath?: string;
  /** Override the reporter module specifier (absolute path for local repo tests). */
  reporterModule?: string;
  /** Directory the reporter writes manifests to (default `.airlock/reports`). */
  outputDir?: string;
  /** Also generate the tsconfig path alias + auto fixture shim for network replay and a fixed clock. */
  determinism?: boolean;
}

export interface AttachPlan {
  /** Absolute project root. */
  projectDir: string;
  /** Absolute path of the detected/explicit Playwright config. */
  configPath: string;
  /** Absolute path of the wrapper config that will be written. */
  wrapperPath: string;
  /** TypeScript source of the wrapper config. */
  wrapperContent: string;
  /** Reporter output directory embedded in the wrapper (relative to the Playwright cwd by default). */
  outputDir: string;
  /** Module specifier the wrapper imports the reporter from. */
  reporterModule: string;
  /** Human-readable next steps. */
  instructions: string[];
  /** Whether deterministic replay/clock fixtures are included in this attach. */
  determinism: boolean;
  /** Extra generated files (absolute path + content); the wrapper is separate. */
  files: { path: string; content: string }[];
}

export interface WriteAttachOptions {
  /** Replace an existing wrapper (default false). The original config is never touched either way. */
  force?: boolean;
  /** Injectable clock for attach.json's createdAt (tests). */
  now?: () => Date;
}

interface PackageJsonShape {
  name?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  peerDependencies?: unknown;
}

function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function readPackageJson(projectDir: string): PackageJsonShape | null {
  const file = path.join(projectDir, 'package.json');
  if (!isFile(file)) return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as PackageJsonShape) : null;
  } catch {
    return null;
  }
}

/** Package names that look like the installed Airlock package (repo checkout or consumed dependency). */
function airlockPackageName(pkg: PackageJsonShape | null): string | undefined {
  if (!pkg) return undefined;
  const sections = [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies];
  for (const section of sections) {
    if (!section || typeof section !== 'object') continue;
    const match = Object.keys(section).find((name) => name === FALLBACK_PACKAGE_NAME || name.endsWith('/airlockqa'));
    if (match) return match;
  }
  if (typeof pkg.name === 'string' && pkg.name.trim() !== '') {
    const name = pkg.name.trim();
    // Running inside the Airlock repo (or a checked-out copy) is the useful "package name" case.
    if (name === FALLBACK_PACKAGE_NAME || name.endsWith('/airlockqa')) return name;
  }
  return undefined;
}

/**
 * Default reporter module: the installed Airlock package + compiled reporter entry.
 * The task's rule is "package name from package.json, fallback airlockqa"; when the project is an
 * unrelated app (its own name is not the Airlock package) the fallback is the only usable specifier,
 * so an app's own package name is never used as the module.
 */
export function defaultReporterModule(projectDir: string): string {
  const name = airlockPackageName(readPackageJson(projectDir)) ?? FALLBACK_PACKAGE_NAME;
  return `${name}/${REPORTER_ENTRY}`;
}

function stripTsExtension(file: string): string {
  // TypeScript resolves extension-less imports to .ts while Playwright's loader honours the
  // wrapper's own `import`; a plain .js next to a TS wrapper needs its extension to be found.
  if (/\.(ts|cts|mts)$/i.test(file)) return file.replace(/\.(ts|cts|mts)$/i, '');
  return file;
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

function relativeImport(fromDir: string, target: string): string {
  const relative = toPosix(path.relative(fromDir, target));
  return relative.startsWith('.') ? relative : `./${relative}`;
}

/** Find (or validate) the Playwright config. Throws an actionable error when there is none. */
export function detectConfigPath(projectDir: string, configPath?: string): string {
  const root = path.resolve(projectDir);
  if (configPath !== undefined && configPath.trim() !== '') {
    const resolved = path.isAbsolute(configPath) ? path.resolve(configPath) : path.resolve(root, configPath);
    const relative = path.relative(root, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`configPath must point inside projectDir (${root}); got ${resolved}`);
    }
    if (!isFile(resolved)) {
      throw new Error(`Playwright config not found at ${resolved}. Pass --config <file> or fix configPath.`);
    }
    return resolved;
  }
  for (const candidate of PLAYWRIGHT_CONFIG_CANDIDATES) {
    const resolved = path.join(root, candidate);
    if (isFile(resolved)) return resolved;
  }
  throw new Error(
    `No Playwright config found in ${root} (looked for ${PLAYWRIGHT_CONFIG_CANDIDATES.join(', ')}). ` +
      'Create a playwright.config.ts/js at the project root, or pass configPath.',
  );
}

function renderWrapperContent(options: {
  baseImport: string;
  reporterModule: string;
  outputDir: string;
  relWrapperPath: string;
  /** Relative path from the wrapper's directory (.airlock/) to the base config's directory. */
  baseDirFromWrapper: string;
  /** File name of the generated tsconfig (relative to the wrapper directory), when determinism is on. */
  determinismConfigFile?: string;
}): string {
  const outputDirLiteral = JSON.stringify(options.outputDir);
  // Playwright only accepts reporter entries as a module specifier string (or [string, options]);
  // `loadReporter()` path.resolve()s the first tuple element, so a class/instance here would crash
  // the run. The reporter module is therefore referenced by specifier, not imported.
  const reporterEntry = `[${JSON.stringify(options.reporterModule)}, { outputDir: ${outputDirLiteral} }]`;
  return `// Generated by the Airlock attach planner — safe to delete.
// It imports your existing Playwright config unchanged and only appends the Airlock reporter.
//
// Run your suite with the wrapper (from the project root):
//   npx playwright test --config ${options.relWrapperPath}
import * as path from 'node:path';
import baseConfig from ${JSON.stringify(options.baseImport)};

/** Keep every reporter the user already configured: a string, one [name, options] tuple, or an array. */
function existingReporters(reporter: unknown): unknown[] {
  if (reporter === undefined || reporter === null || reporter === false) return [];
  if (!Array.isArray(reporter)) return [reporter];
  const looksLikeSingleTuple =
    reporter.length === 2 &&
    typeof reporter[1] === 'object' &&
    reporter[1] !== null &&
    !Array.isArray(reporter[1]) &&
    (typeof reporter[0] === 'string' || typeof reporter[0] === 'function');
  return looksLikeSingleTuple ? [[...reporter]] : [...reporter];
}

// Playwright resolves config-relative paths against the directory of the config file it loaded.
// This wrapper lives in .airlock/, so rebase the base config's paths onto the base config's own
// directory to keep test discovery (testDir/rootDir) and helper scripts identical.
const baseConfigDir = ${JSON.stringify(options.baseDirFromWrapper)};
// The attach determinism shim + tsconfig path alias live next to this wrapper.
// Use cwd, not import.meta: Playwright loads TS configs through a CJS require by default.
const airlockConfigDir = path.resolve(process.cwd(), ${JSON.stringify(path.dirname(options.relWrapperPath))});
const baseConfigAbsDir = path.resolve(airlockConfigDir, baseConfigDir);
function rebasePath(value: unknown): unknown {
  if (typeof value === 'string') return path.isAbsolute(value) ? value : path.join(baseConfigDir, value);
  if (Array.isArray(value)) return value.map(rebasePath);
  return value;
}
/** Rebase a relative reporter module path only; package names and absolute paths stay untouched. */
// Some Playwright options (notably use.storageState and webServer.cwd) resolve against the process
// cwd rather than the config file; they must be absolute for the wrapper to be correct anywhere.
function rebaseAbsolutePath(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return path.isAbsolute(value) ? value : path.resolve(baseConfigAbsDir, value);
}
function rebaseModule(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (!value.startsWith('./') && !value.startsWith('../')) return value;
  return path.join(baseConfigDir, value);
}
function rebaseReporters(reporter: unknown): unknown[] {
  return existingReporters(reporter).map((entry) => {
    if (typeof entry === 'string') return rebaseModule(entry);
    if (Array.isArray(entry) && entry.length > 0) return [rebaseModule(entry[0]), ...entry.slice(1)];
    return entry;
  });
}
function rebaseUse(use: unknown): unknown {
  if (!use || typeof use !== 'object' || Array.isArray(use)) return use;
  const entry = use as Record<string, unknown>;
  return {
    ...entry,
    ...(entry.storageState !== undefined ? { storageState: rebaseAbsolutePath(entry.storageState) } : {}),
  };
}
function rebaseWebServer(webServer: unknown): unknown {
  const rebaseEntry = (entry: unknown): unknown => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const server = entry as Record<string, unknown>;
    return { ...server, ...(server.cwd !== undefined ? { cwd: rebaseAbsolutePath(server.cwd) } : {}) };
  };
  return Array.isArray(webServer) ? webServer.map(rebaseEntry) : rebaseEntry(webServer);
}
function rebaseProjects(projects: unknown): unknown {
  if (!Array.isArray(projects)) return projects;
  return projects.map((project) => {
    if (!project || typeof project !== 'object') return project;
    const entry = project as Record<string, unknown>;
    return {
      ...entry,
      ...(entry.testDir !== undefined ? { testDir: rebasePath(entry.testDir) } : {}),
      ...(entry.outputDir !== undefined ? { outputDir: rebasePath(entry.outputDir) } : {}),
      ...(entry.snapshotDir !== undefined ? { snapshotDir: rebasePath(entry.snapshotDir) } : {}),
      ...(entry.use !== undefined ? { use: rebaseUse(entry.use) } : {}),
    };
  });
}

const base = baseConfig as Record<string, unknown>;
export default {
  ...base,
  testDir: rebasePath(base.testDir ?? '.'),
  ...(base.outputDir !== undefined ? { outputDir: rebasePath(base.outputDir) } : {}),
  ...(base.snapshotDir !== undefined ? { snapshotDir: rebasePath(base.snapshotDir) } : {}),
  ...(base.tsconfig !== undefined ? { tsconfig: rebasePath(base.tsconfig) } : {}),
  ...(base.globalSetup !== undefined ? { globalSetup: rebasePath(base.globalSetup) } : {}),
  ...(base.globalTeardown !== undefined ? { globalTeardown: rebasePath(base.globalTeardown) } : {}),
  ...(base.projects !== undefined ? { projects: rebaseProjects(base.projects) } : {}),
  ...(base.use !== undefined ? { use: rebaseUse(base.use) } : {}),
  ...(base.webServer !== undefined ? { webServer: rebaseWebServer(base.webServer) } : {}),
  ${options.determinismConfigFile ? `// Resolve the generated tsconfig relative to this wrapper, not the process cwd.
  tsconfig: path.join(airlockConfigDir, ${JSON.stringify(options.determinismConfigFile)}),` : ''}
  reporter: [
    ...rebaseReporters(base.reporter),
    ${reporterEntry},
  ],
} as unknown as typeof baseConfig;
`;
}

/**
 * Build an attach plan for an existing Playwright project. Pure: does not write anything.
 * Throws with an actionable message when no Playwright config can be found.
 */
export function planAttach(options: AttachOptions): AttachPlan {
  if (!options || typeof options.projectDir !== 'string' || options.projectDir.trim() === '') {
    throw new Error('planAttach needs projectDir (the directory that holds playwright.config.*)');
  }
  const projectDir = path.resolve(options.projectDir);
  let projectStats: fs.Stats;
  try {
    projectStats = fs.statSync(projectDir);
  } catch {
    throw new Error(`Project directory not found: ${projectDir}`);
  }
  if (!projectStats.isDirectory()) throw new Error(`projectDir is not a directory: ${projectDir}`);

  const configPath = detectConfigPath(projectDir, options.configPath);
  const airlockDir = path.join(projectDir, '.airlock');
  const wrapperPath = path.join(projectDir, AIRLOCK_WRAPPER_RELATIVE_PATH);
  const outputDir = typeof options.outputDir === 'string' && options.outputDir.trim() !== '' ? options.outputDir.trim() : DEFAULT_ATTACH_OUTPUT_DIR;
  const reporterModule =
    typeof options.reporterModule === 'string' && options.reporterModule.trim() !== ''
      ? options.reporterModule.trim()
      : defaultReporterModule(projectDir);
  const baseImport = stripTsExtension(relativeImport(airlockDir, configPath));
  const relWrapperPath = toPosix(path.relative(projectDir, wrapperPath));
  const relConfigPath = toPosix(path.relative(projectDir, configPath));
  const baseDirFromWrapper = toPosix(path.relative(airlockDir, path.dirname(configPath))) || '.';

  const determinism = options.determinism === true;
  const determinismConfigFile = determinism ? 'tsconfig.airlock.json' : undefined;
  const wrapperContent = renderWrapperContent({
    baseImport,
    reporterModule,
    outputDir,
    relWrapperPath,
    baseDirFromWrapper,
    determinismConfigFile,
  });

  const files: { path: string; content: string }[] = [];
  if (determinism) {
    const extra = renderDeterminismFiles(projectDir, airlockDir);
    files.push(...extra.files);
    // The wrapper needs a deterministic shim file and tsconfig next to it.
    files.push({
      path: path.join(airlockDir, determinismConfigFile as string),
      content: extra.tsconfigContent,
    });
    files.push({
      path: path.join(airlockDir, 'airlock-test.ts'),
      content: extra.shimContent,
    });
  }

  return {
    projectDir,
    configPath,
    wrapperPath,
    wrapperContent,
    outputDir,
    reporterModule,
    determinism,
    files,
    instructions: [
      `Run your suite with the generated wrapper: npx playwright test --config ${relWrapperPath}`,
      `Your original Playwright config was not modified: ${relConfigPath}`,
      `Airlock manifests are written to ${outputDir}/<runId>.json and aggregated by \`airlock flake\`.`,
      'Commit .airlock/playwright.airlock.config.ts and .airlock/attach.json if CI should reuse this wrap, or regenerate with the attach planner.',
      'The wrapper preserves every reporter already configured in the base config (rebasing its relative paths), rebases use.storageState and webServer.cwd, and appends the Airlock reporter.',
      ...(determinism
        ? [
            'Determinism is on: specs import @playwright/test as before; the generated shim injects network record/replay + a fixed clock.',
            'Seed the network once with AIRLOCK_ATTACH_NETWORK=record, commit .airlock/network, then run CI with AIRLOCK_ATTACH_NETWORK=replay.',
            'Set AIRLOCK_ATTACH_CLOCK=off to disable the fixed clock for one run, or AIRLOCK_ATTACH_TIME to choose the instant.',
          ]
        : []),
    ],
  };
}

/** Resolve the app's concrete @playwright/test entry and the Airlock fixture module for the shim. */
function renderDeterminismFiles(
  projectDir: string,
  airlockDir: string,
): { files: { path: string; content: string }[]; tsconfigContent: string; shimContent: string } {
  let playwrightEntry: string;
  try {
    const requireFromProject = createRequire(path.join(projectDir, 'package.json'));
    playwrightEntry = requireFromProject.resolve('@playwright/test');
  } catch {
    throw new Error(
      'Determinism attach needs @playwright/test installed in the project (it is a peer dependency of any Playwright suite). ' +
        'Run npm install in the project, or attach without --determinism.',
    );
  }
  // CJS/ESM-neutral: Playwright may require the package from a CJS spec. Locate the fixture module
  // relative to the CLI entry point (bin/airlock.ts or dist/bin) or the working directory.
  const roots = [
    process.argv[1] ? path.dirname(path.dirname(path.resolve(process.argv[1]))) : '',
    process.cwd(),
  ].filter((root): root is string => root.length > 0);
  const fixturesModule = roots.flatMap((root) => [
    path.join(root, 'src', 'testing', 'attach-fixtures.ts'),
    path.join(root, 'dist', 'src', 'testing', 'attach-fixtures.js'),
  ]).find((candidate) => fs.existsSync(candidate));
  if (!fixturesModule) {
    throw new Error(
      'Determinism attach could not find the Airlock fixture module (src/testing/attach-fixtures.ts or dist/src/testing/attach-fixtures.js). ' +
        'Run the CLI from a repository build that includes src/testing/attach-fixtures.ts.',
    );
  }

  // @playwright/test ships as CJS; an ESM named import fails. Use createRequire in the generated
  // shim and re-export the API surface specs use, with our extended test shadowing the base one.
  const shimLines = [
    '// Generated by the Airlock attach planner for deterministic replay/clock — safe to delete.',
    '// It re-exports the Playwright test API extended with Airlock auto-use determinism fixtures.',
    '// The tsconfig path alias maps "@playwright/test" here for the wrapper run, so specs need no changes.',
    'import { createRequire } from "node:module";',
    `import { airlockDeterminismFixtures } from ${JSON.stringify(fixturesModule)};`,
    `const pw = createRequire(process.cwd() + "/package.json")(${JSON.stringify(playwrightEntry)});`,
    'export const test = pw.test.extend(airlockDeterminismFixtures as never);',
    'export const expect = pw.expect;',
    'export const defineConfig = pw.defineConfig;',
    'export const devices = pw.devices;',
    'export const chromium = pw.chromium;',
    'export const firefox = pw.firefox;',
    'export const webkit = pw.webkit;',
    'export const selectors = pw.selectors;',
    'export const request = pw.request;',
    'export const errors = pw.errors;',
    'export const mergeTests = pw.mergeTests;',
    'export const mergeExpects = pw.mergeExpects;',
    'export default pw;',
    '',
  ];
  const shimContent = shimLines.join('\n');

  const userTsconfig = path.join(projectDir, 'tsconfig.json');
  let extendsValue: string | undefined;
  let existingPaths: Record<string, unknown> = {};
  if (fs.existsSync(userTsconfig)) {
    extendsValue = toPosix(relativeImport(airlockDir, userTsconfig));
    try {
      const parsed = JSON.parse(fs.readFileSync(userTsconfig, 'utf8')) as { compilerOptions?: { paths?: unknown } };
      if (parsed.compilerOptions && parsed.compilerOptions.paths && typeof parsed.compilerOptions.paths === 'object') {
        existingPaths = { ...(parsed.compilerOptions.paths as Record<string, unknown>) };
      }
    } catch {
      // A tsconfig with comments is valid for TypeScript but not JSON.parse; extends still applies.
    }
  }
  const tsconfigObject: Record<string, unknown> = {
    ...(extendsValue ? { extends: extendsValue } : {}),
    compilerOptions: {
      baseUrl: '.',
      paths: { ...existingPaths, '@playwright/test': ['./airlock-test'] },
    },
  };
  const tsconfigContent = JSON.stringify(tsconfigObject, null, 2) + '\n';

  return { files: [], tsconfigContent, shimContent };
}

/** Fields written to `.airlock/attach.json`. */
export interface AttachMetadata {
  configPath: string;
  reporterModule: string;
  outputDir: string;
  createdAt: string;
}

/** Write the wrapper config and `.airlock/attach.json`. Returns the written absolute paths. */
export function writeAttachPlan(plan: AttachPlan, options: WriteAttachOptions = {}): string[] {
  if (!plan || typeof plan.wrapperPath !== 'string' || typeof plan.wrapperContent !== 'string') {
    throw new Error('writeAttachPlan needs a plan from planAttach()');
  }
  const projectDir = path.resolve(plan.projectDir);
  const airlockDir = path.join(projectDir, '.airlock');
  const wrapperPath = plan.wrapperPath;
  const metadataPath = path.join(projectDir, AIRLOCK_ATTACH_METADATA_RELATIVE_PATH);

  if (fs.existsSync(wrapperPath) && options.force !== true) {
    throw new Error(
      `Refusing to overwrite ${toPosix(path.relative(projectDir, wrapperPath))}: it already exists. ` +
        'Re-run with force to replace it (the original Playwright config is never modified).',
    );
  }

  fs.mkdirSync(airlockDir, { recursive: true });
  fs.writeFileSync(wrapperPath, plan.wrapperContent, 'utf8');
  const written = [wrapperPath];
  for (const file of plan.files || []) {
    fs.mkdirSync(path.dirname(file.path), { recursive: true });
    fs.writeFileSync(file.path, file.content, 'utf8');
    written.push(file.path);
  }

  const clock = typeof options.now === 'function' ? options.now : () => new Date();
  const metadata: AttachMetadata = {
    configPath: toPosix(path.relative(projectDir, plan.configPath)),
    reporterModule: plan.reporterModule,
    outputDir: plan.outputDir,
    createdAt: clock().toISOString(),
  };
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2) + '\n', 'utf8');

  return [...written, metadataPath];
}
