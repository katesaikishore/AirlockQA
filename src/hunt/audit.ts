/**
 * Repository QA hunt: static audit of an existing Playwright suite for defects that make the suite
 * report the wrong thing, plus a duplicate gate against the repo's issues/PRs before anyone files a
 * report.
 *
 * This is deliberately not a "generate more tests" feature. It reads the suite a team already has and
 * points at places where the test code itself is a QA bug: unawaited expectations, tests that cannot
 * fail, fixed sleeps, focused tests, and disabled cases. Every candidate is meant to be reproduced and
 * checked against the issue tracker before a PR.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export type HuntSeverity = 'high' | 'medium' | 'low';

export interface HuntCandidate {
  rule: string;
  severity: HuntSeverity;
  file: string;
  line: number;
  title: string;
  detail: string;
  evidence: string;
}

export interface HuntAudit {
  root: string;
  files: number;
  testCalls: number;
  candidates: HuntCandidate[];
}

const SEVERITY_ORDER: Record<HuntSeverity, number> = { high: 3, medium: 2, low: 1 };

function severityAtLeast(value: HuntSeverity, minimum: HuntSeverity): boolean {
  return SEVERITY_ORDER[value] >= SEVERITY_ORDER[minimum];
}

function walkSourceFiles(dir: string, acc: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'build') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkSourceFiles(full, acc);
    else if (entry.isFile() && /\.(spec|test)?\.?(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

function walkFiles(dir: string, acc: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'build') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, acc);
    else if (entry.isFile() && /\.(spec|test)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

function relative(root: string, file: string): string {
  return file.slice(root.length + 1).split(path.sep).join('/');
}

interface Node {
  type: string;
  start?: number;
  end?: number;
  loc?: { start: { line: number } };
  [key: string]: unknown;
}

type Parse = (source: string, options: Record<string, unknown>) => Node;

async function loadParser(): Promise<Parse | null> {
  try {
    const module = (await import('@babel/parser')) as unknown as { parse?: Parse; default?: { parse?: Parse } };
    const parse = module.parse || module.default?.parse;
    return typeof parse === 'function' ? parse : null;
  } catch {
    return null;
  }
}

function childNodes(node: Node): Node[] {
  const children: Node[] = [];
  for (const value of Object.values(node)) {
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      for (const item of value) if (item && typeof item === 'object' && typeof (item as Node).type === 'string') children.push(item as Node);
    } else if (typeof (value as Node).type === 'string') {
      children.push(value as Node);
    }
  }
  return children;
}

function dotted(node: Node | undefined): string {
  if (!node) return '';
  if (node.type === 'Identifier') return String(node.name);
  if (node.type === 'ThisExpression') return 'this';
  if (node.type === 'MemberExpression') {
    const object = dotted(node.object as Node | undefined);
    const property = node.computed ? '' : dotted(node.property as Node | undefined);
    return object && property ? `${object}.${property}` : object || property;
  }
  if (node.type === 'CallExpression') return `${dotted(node.callee as Node | undefined)}()`;
  return '';
}

function stringArgument(call: Node): string {
  const args = (call.arguments as Node[] | undefined) || [];
  const first = args[0];
  if (first && (first.type === 'StringLiteral' || first.type === 'Literal')) return String(first.value ?? '');
  return '';
}

function findFunction(node: Node): Node | undefined {
  const args = (node.arguments as Node[] | undefined) || [];
  return args.find((argument) => argument && (argument.type === 'ArrowFunctionExpression' || argument.type === 'FunctionExpression' || argument.type === 'FunctionDeclaration'));
}

function callsAny(body: Node | undefined, names: Set<string>): boolean {
  if (!body) return false;
  let found = false;
  const visit = (node: Node): void => {
    if (found) return;
    if (node.type === 'CallExpression') {
      const name = dotted(node.callee as Node | undefined).split('.').pop() || '';
      if (names.has(name)) found = true;
    }
    for (const child of childNodes(node)) visit(child);
  };
  visit(body);
  return found;
}

function collectAssertionHelpers(ast: Node): Set<string> {
  const helpers = new Set<string>();
  const visit = (node: Node): void => {
    const id = (node as { id?: Node }).id;
    const init = (node as { init?: Node }).init;
    if (node.type === 'FunctionDeclaration' && id?.type === 'Identifier' && countExpects(node) > 0) {
      helpers.add(String(id.name));
    }
    if (node.type === 'VariableDeclarator' && id?.type === 'Identifier' && init && (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') && countExpects(init) > 0) {
      helpers.add(String(id.name));
    }
    for (const child of childNodes(node)) visit(child);
  };
  visit(ast);
  return helpers;
}

function countExpects(body: Node | undefined): number {
  if (!body) return 0;
  let count = 0;
  const visit = (node: Node): void => {
    if (node.type === 'CallExpression' && dotted(node.callee as Node | undefined).startsWith('expect')) count += 1;
    for (const child of childNodes(node)) visit(child);
  };
  visit(body);
  return count;
}

const ASYNC_MATCHERS = new Set([
  'toHaveText', 'toContainText', 'toBeVisible', 'toBeHidden', 'toBeAttached', 'toBeChecked', 'toBeDisabled',
  'toBeEnabled', 'toBeEditable', 'toBeEmpty', 'toBeFocused', 'toHaveAttribute', 'toHaveClass', 'toHaveCount',
  'toHaveCSS', 'toHaveId', 'toHaveJSProperty', 'toHaveScreenshot', 'toHaveTitle', 'toHaveURL', 'toHaveValue',
  'toHaveValues', 'toHaveAccessibleName', 'toHaveAccessibleDescription', 'toBeInViewport',
]);

type HelperIndex = Map<string, Set<string>>;

const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];

function resolveRelativeImport(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base, ...RESOLVE_EXTENSIONS.map((ext) => base + ext)];
  for (const extension of RESOLVE_EXTENSIONS) candidates.push(path.join(base, 'index' + extension));
  return candidates.find((candidate) => {
    try { return fs.statSync(candidate).isFile(); } catch { return false; }
  });
}

/** Index every function/method in a file that contains an expect, including exports/defaults. */
function helperNamesForAst(ast: Node): Set<string> {
  const names = new Set<string>();
  const visit = (node: Node): void => {
    if (node.type === 'FunctionDeclaration') {
      const id = (node as { id?: Node }).id;
      if (id?.type === 'Identifier' && countExpects(node) > 0) names.add(String(id.name));
    }
    if (node.type === 'VariableDeclarator') {
      const id = (node as { id?: Node }).id;
      const init = (node as { init?: Node }).init;
      if (id?.type === 'Identifier' && init && (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') && countExpects(init) > 0) {
        names.add(String(id.name));
      }
    }
    for (const child of childNodes(node)) visit(child);
  };
  visit(ast);
  return names;
}

async function buildHelperIndex(root: string, parse: Parse): Promise<HelperIndex> {
  const index: HelperIndex = new Map();
  for (const file of walkSourceFiles(root)) {
    try {
      const source = fs.readFileSync(file, 'utf8');
      const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'], errorRecovery: true });
      const names = helperNamesForAst(ast);
      if (names.size) index.set(path.resolve(file), names);
    } catch {
      // Unparseable helper file: skip, but never fail the whole audit.
    }
  }
  return index;
}

/** Imported helper names visible to a spec (aliases included). Relative imports only. */
function importedHelpers(ast: Node, file: string, index: HelperIndex): Set<string> {
  const imported = new Set<string>();
  const visit = (node: Node): void => {
    if (node.type === 'ImportDeclaration') {
      const source = (node as { source?: Node }).source;
      const specifiers = (node as { specifiers?: Node[] }).specifiers || [];
      const specifierValue = source && source.type === 'StringLiteral' ? String(source.value) : '';
      const target = resolveRelativeImport(file, specifierValue);
      if (process.env.HUNT_DEBUG) console.error('[hunt] import', specifierValue, 'from', file, '->', target);
      if (!target) return;
      const fileHelpers = index.get(path.resolve(target));
      if (process.env.HUNT_DEBUG) console.error('[hunt] helpers for', specifierValue, [...(fileHelpers || [])]);
      if (!fileHelpers) return;
      for (const specifier of specifiers) {
        const local = (specifier as { local?: Node }).local;
        const importedName = (specifier as { imported?: Node }).imported;
        if (specifier.type === 'ImportNamespaceSpecifier') {
          for (const name of fileHelpers) imported.add(name);
        } else if (local?.type === 'Identifier') {
          const name = specifier.type === 'ImportDefaultSpecifier' ? 'default' : String(importedName?.name || '');
          if (fileHelpers.has(name)) imported.add(String(local.name));
        }
      }
    }
    for (const child of childNodes(node)) visit(child);
  };
  visit(ast);
  return imported;
}

interface ParserContext {
  source: string;
  file: string;
  root: string;
  candidates: HuntCandidate[];
}

function report(ctx: ParserContext, rule: string, severity: HuntSeverity, node: Node, title: string, detail: string): void {
  const start = node.start ?? 0;
  const evidence = ctx.source.slice(start, Math.min((node.end ?? start + 160), start + 180)).replace(/\s+/g, ' ').trim();
  ctx.candidates.push({ rule, severity, file: ctx.file, line: node.loc?.start.line ?? 1, title, detail, evidence });
}

/** Playwright-specific async matcher/action rules must not fire on Vitest/Jest/Testing Library files. */
function isPlaywrightSource(source: string): boolean {
  return /from\s+['"](?:@playwright\/test|playwright\/test)['"]/.test(source)
    || /require\(\s*['"](?:@playwright\/test|playwright\/test)['"]\s*\)/.test(source);
}

function isUnitTestSource(source: string): boolean {
  return /from\s+['"](?:vitest|@jest\/globals|@testing-library\/[^'"]+)['"]/.test(source)
    || /require\(\s*['"](?:vitest|@jest\/globals|@testing-library\/[^'"]+)['"]\s*\)/.test(source);
}

function parseCandidates(ctx: ParserContext, parse: Parse, helperIndex: HelperIndex): void {
  if (isUnitTestSource(ctx.source)) return;
  let ast: Node;
  try {
    ast = parse(ctx.source, { sourceType: 'module', plugins: ['typescript', 'jsx'], errorRecovery: true });
  } catch {
    return;
  }
  const playwrightFile = isPlaywrightSource(ctx.source);
  if (!playwrightFile) return;
  const assertionHelpers = new Set([...collectAssertionHelpers(ast), ...importedHelpers(ast, path.resolve(ctx.root, ctx.file), helperIndex)]);
  const visit = (node: Node, parent?: Node): void => {
    if (node.type === 'CallExpression') {
      const name = dotted(node.callee as Node | undefined);
      const base = name.split('.').pop() || '';

      if ((name === 'test' || name === 'it') && !findFunction(node)) {
        // test('title', cb) with a non-function callback is itself a bug, but leave it to TypeScript.
      }
      if (name === 'test' || name === 'it') {
        const body = findFunction(node);
        if (body && countExpects(body) === 0 && !callsAny(body, assertionHelpers)) {
          report(ctx, 'assertion-free-test', 'medium', node, `Test has no expectation: ${stringArgument(node)}`,
            'The callback contains no expect() call. It can pass while the behaviour it names is broken; add an explicit assertion.');
        }
      }

      if (name.endsWith('.only')) {
        report(ctx, 'focused-test', 'high', node, 'Focused test left in the suite (.only)',
          'On CI this skips every other test in the file/project. Remove .only before merging.');
      }

      if (base === 'waitForTimeout' || name.endsWith('.waitForTimeout') || base === 'sleep' || name.endsWith('.sleep')) {
        report(ctx, 'fixed-wait', 'low', node, 'Fixed wait instead of an observable condition',
          'waitForTimeout/sleep makes the suite timing-dependent. Wait for a locator, response or state instead.');
      }

      if (name === 'test.skip' || name === 'test.fixme') {
        const args = (node.arguments as Node[] | undefined) || [];
        const first = args[0];
        const unconditional = args.length === 0 || (first && first.type === 'StringLiteral');
        if (unconditional) {
          report(ctx, 'skipped-test', 'low', node, `Skipped test: ${stringArgument(node)}`,
            'Confirm the skip is linked to an issue and has an owner; untracked skips silently remove coverage.');
        }
      }

      // Bare expression statements are checked below on the parent ExpressionStatement.
    }

    if (node.type === 'ExpressionStatement') {
      const expression = node.expression as Node | undefined;
      if (expression && expression.type === 'CallExpression' && parent?.type !== 'AwaitExpression') {
        const text = ctx.source.slice(expression.start ?? 0, Math.min(expression.end ?? 0, (expression.start ?? 0) + 220));
        if (/^expect(\.|\()/.test(text)) {
          // Only async Playwright matchers need await; expect(a).toBe(b) is synchronous Jest-style.
          const callee = expression.callee as Node | undefined;
          const matcher = callee && callee.type === 'MemberExpression' && !callee.computed
            ? String((callee.property as Node | undefined)?.name || '')
            : '';
          if (playwrightFile && ASYNC_MATCHERS.has(matcher)) {
            report(ctx, 'unawaited-expect', 'high', node, 'Unawaited expectation matcher',
              'Playwright matchers are async; without await the test can finish before the assertion fails.');
          }
        } else if (playwrightFile && /^(page|context|request|locator)\b/.test(text) && /\.(click|fill|press|check|selectOption|tap|goto|waitFor|type)\(/.test(text) && !/\.(on|once|off)\(/.test(text)) {
          report(ctx, 'unawaited-action', 'medium', node, 'Unawaited browser action',
            'The action may not have completed before the next step or the test end. Await it.');
        }
      }
    }

    for (const child of childNodes(node)) visit(child, node);
  };
  visit(ast);
}

function regexFallback(parsed: Array<{ file: string; source: string }>): HuntCandidate[] {
  const candidates: HuntCandidate[] = [];
  for (const { file, source } of parsed) {
    if (isUnitTestSource(source)) continue;
    const playwrightSource = isPlaywrightSource(source);
    if (!playwrightSource) continue;
    const lines = source.split('\n');
    lines.forEach((line, index) => {
      const text = line.trim();
      const lineNo = index + 1;
      const report = (rule: string, severity: HuntSeverity, title: string, detail: string): void => {
        candidates.push({ rule, severity, file, line: lineNo, title, detail, evidence: text.slice(0, 160) });
      };
      if (playwrightSource && /^expect\(.*\)\.(toHaveText|toContainText|toBeVisible|toBeHidden|toBeAttached|toBeChecked|toBeDisabled|toBeEnabled|toBeEditable|toBeEmpty|toBeFocused|toBeInViewport|toHaveAttribute|toHaveClass|toHaveCount|toHaveCSS|toHaveId|toHaveJSProperty|toHaveScreenshot|toHaveTitle|toHaveURL|toHaveValue|toHaveValues|toHaveAccessibleName|toHaveAccessibleDescription)\(/.test(text)) report('unawaited-expect', 'high', 'Unawaited expectation matcher', 'Add await; async Playwright matchers need it.');
      if (/^[a-z]+\.only\(|^test\.only\(/i.test(text)) report('focused-test', 'high', 'Focused test left in the suite (.only)', 'Remove .only.');
      if (/\.waitForTimeout\(|^\s*sleep\(/.test(text)) report('fixed-wait', 'medium', 'Fixed wait instead of an observable condition', 'Wait for a locator/response/state.');
      if (playwrightSource && /^\s*(page|locator|context)\.\w+\(.*\)(\.\w+\(.*\))?$/.test(text) && !/await|expect/.test(text)) report('unawaited-action', 'medium', 'Possibly unawaited browser action', 'Check the action is awaited.');
    });
  }
  return candidates;
}

/** Audit a directory of Playwright tests. Uses Babel's parser when available and a regex fallback otherwise. */
export async function auditPlaywrightDirectory(
  root: string,
  options: { minSeverity?: HuntSeverity; maxCandidates?: number } = {},
): Promise<HuntAudit> {
  const resolved = path.resolve(root);
  if (!fs.existsSync(resolved)) throw new Error(`Directory not found: ${resolved}`);
  const files = walkFiles(resolved);
  const parsed = files.map((file) => ({ file, source: fs.readFileSync(file, 'utf8') }));
  const parse = await loadParser();
  const candidates: HuntCandidate[] = [];
  if (parse) {
    const helperIndex = await buildHelperIndex(resolved, parse);
    for (const file of parsed) {
      parseCandidates({ source: file.source, file: relative(resolved, file.file), root: resolved, candidates }, parse, helperIndex);
    }
  } else {
    candidates.push(...regexFallback(parsed));
  }

  const seen = new Set<string>();
  const unique = candidates.filter((candidate) => {
    const key = `${candidate.rule}::${candidate.file}::${candidate.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const minimum = options.minSeverity;
  const filtered = minimum ? unique.filter((candidate) => severityAtLeast(candidate.severity, minimum)) : unique;
  filtered.sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] || a.file.localeCompare(b.file) || a.line - b.line);
  const cap = options.maxCandidates && options.maxCandidates > 0 ? options.maxCandidates : 200;

  return {
    root: resolved,
    files: files.length,
    testCalls: parsed.reduce((count, file) => count + ((file.source.match(/\b(test|it)\s*\(/g) || []).length), 0),
    candidates: filtered.slice(0, cap).map((candidate) => ({
      ...candidate,
      file: candidate.file.includes('/') || candidate.file.includes(path.sep) ? candidate.file : relative(resolved, path.join(resolved, candidate.file)),
    })),
  };
}

export function renderHuntReport(audit: HuntAudit): string {
  const lines = [
    '# Playwright QA audit',
    '',
    `- Root: \`${audit.root}\``,
    `- Test files: ${audit.files}`,
    `- Test calls: ${audit.testCalls}`,
    `- Candidates: ${audit.candidates.length}`,
    '',
    '| Severity | Rule | File:line | Candidate |',
    '| :--- | :--- | :--- | :--- |',
  ];
  for (const candidate of audit.candidates) {
    lines.push(`| ${candidate.severity} | ${candidate.rule} | \`${candidate.file}:${candidate.line}\` | ${candidate.title.replace(/\|/g, '\\|')} |`);
  }
  lines.push('', '## Details', '');
  for (const candidate of audit.candidates) {
    lines.push(
      `### ${candidate.title}`,
      '',
      `- ${candidate.severity} · \`${candidate.rule}\` · \`${candidate.file}:${candidate.line}\``,
      `- ${candidate.detail}`,
      '',
      '```',
      candidate.evidence,
      '```',
      '',
    );
  }
  lines.push('Every candidate must be reproduced against the current commit and checked against the issue tracker before a PR.');
  return lines.join('\n');
}
