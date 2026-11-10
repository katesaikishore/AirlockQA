import { execFileSync } from 'node:child_process';
import type { ChangedFile, DiffLine, ReviewInput } from './review-types.js';

const TEST_PATH_PATTERNS = [
  /(^|\/)(tests?|__tests__|e2e|specs?)\//i,
  /\.(test|spec|e2e)\.[cm]?[jt]sx?$/i,
  /(^|\/)(playwright|cypress)\.config\.[cm]?[jt]s$/i,
];
const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]sx?|vue|svelte|astro|go|rs|py|rb|java|kt|swift|php|cs|cpp|c|h)$/i;

export function isTestFile(filePath: string): boolean {
  return TEST_PATH_PATTERNS.some((pattern) => pattern.test(filePath));
}

export function isSourceFile(filePath: string): boolean {
  return SOURCE_EXTENSIONS.test(filePath) && !isTestFile(filePath) && !/\.d\.[cm]?ts$/i.test(filePath);
}

function cleanDiffPath(raw: string): string {
  const withoutPrefix = raw.replace(/^(a|b)\//, '');
  return withoutPrefix === '/dev/null' ? '' : withoutPrefix;
}

/**
 * Parse a unified diff (git/GitHub) into changed files with new-file line numbers.
 * Only added lines are comment targets; removed lines are kept for removal heuristics.
 */
export function parseUnifiedDiff(diff: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  let current: ChangedFile | null = null;
  let newLine = 0;
  let oldLine = 0;
  let inHunk = false;
  let patchLines: string[] = [];
  let isNewFile = false;
  let isDeletedFile = false;

  const finish = () => {
    if (!current) return;
    current.patch = patchLines.join('\n');
    if (isDeletedFile) current.status = 'removed';
    else if (isNewFile) current.status = 'added';
    files.push(current);
    current = null;
    inHunk = false;
    patchLines = [];
    isNewFile = false;
    isDeletedFile = false;
  };

  for (const rawLine of diff.split('\n')) {
    if (rawLine.startsWith('diff --git ')) {
      finish();
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(rawLine);
      const path = match ? match[2] : '';
      current = { path, status: 'modified', addedLines: [], removedLines: [], patch: '' };
      patchLines = [rawLine];
      continue;
    }
    if (!current) continue;

    if (rawLine.startsWith('--- ')) {
      patchLines.push(rawLine);
      if (rawLine.includes('/dev/null')) isNewFile = true;
      continue;
    }
    if (rawLine.startsWith('+++ ')) {
      patchLines.push(rawLine);
      const filePath = cleanDiffPath(rawLine.slice(4).trim());
      if (filePath) current.path = filePath;
      if (rawLine.includes('/dev/null')) isDeletedFile = true;
      continue;
    }
    if (rawLine.startsWith('rename from ')) {
      current.oldPath = rawLine.slice('rename from '.length).trim();
      current.status = 'renamed';
      patchLines.push(rawLine);
      continue;
    }
    if (rawLine.startsWith('rename to ')) {
      current.path = rawLine.slice('rename to '.length).trim();
      current.status = 'renamed';
      patchLines.push(rawLine);
      continue;
    }
    if (rawLine.startsWith('@@')) {
      const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(rawLine);
      if (!match) continue;
      newLine = Number.parseInt(match[1], 10);
      oldLine = newLine;
      inHunk = true;
      patchLines.push(rawLine);
      continue;
    }
    if (!inHunk) {
      patchLines.push(rawLine);
      continue;
    }

    patchLines.push(rawLine);
    if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
      current.addedLines.push({ line: newLine, content: rawLine.slice(1) });
      newLine += 1;
    } else if (rawLine.startsWith('-') && !rawLine.startsWith('---')) {
      current.removedLines.push({ line: oldLine, content: rawLine.slice(1) });
      oldLine += 1;
    } else if (rawLine.startsWith(' ') || rawLine === '') {
      newLine += 1;
      oldLine += 1;
    }
  }
  finish();

  return files.filter((file) => file.path && file.patch.trim().length > 0);
}

export interface BuildReviewInputOptions {
  diff: string;
  pullRequest?: ReviewInput['pullRequest'];
  allTestFiles?: string[];
  maxFiles?: number;
  maxPatchChars?: number;
}

export function buildReviewInput(options: BuildReviewInputOptions): ReviewInput {
  const allFiles = parseUnifiedDiff(options.diff);
  const maxFiles = options.maxFiles ?? 200;
  const files = allFiles.slice(0, maxFiles);
  const maxPatchChars = options.maxPatchChars ?? 120_000;
  let patch = '';
  let truncated = allFiles.length > files.length;
  for (const file of files) {
    if (patch.length >= maxPatchChars) { truncated = true; break; }
    const block = `### ${file.path} (${file.status})\n${file.patch}\n`;
    patch += block;
  }
  if (patch.length > maxPatchChars) { patch = patch.slice(0, maxPatchChars); truncated = true; }
  const testFiles = Array.from(new Set([
    ...(options.allTestFiles ?? []),
    ...files.filter((file) => isTestFile(file.path)).map((file) => file.path),
  ]));
  return { pullRequest: options.pullRequest, files, testFiles, patch, truncated };
}

export function diffFromGit(base: string, head: string, cwd = process.cwd()): string {
  try {
    return execFileSync('git', ['diff', '--unified=3', `${base}...${head}`], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read git diff ${base}...${head}: ${message}`);
  }
}

export function countAddedLines(files: ChangedFile[]): number {
  return files.reduce((sum, file) => sum + file.addedLines.length, 0);
}

export function countRemovedLines(files: ChangedFile[]): number {
  return files.reduce((sum, file) => sum + file.removedLines.length, 0);
}

export function addedLineSet(file: ChangedFile): Set<number> {
  return new Set<number>(file.addedLines.map((line: DiffLine) => line.line));
}
