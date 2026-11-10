/**
 * Duplicate gate for QA bug reports.
 *
 * Before spending time on a repro or a PR, check the repository's issues and pull requests. The gate
 * is intentionally conservative: a similar open item is a BLOCK, a closed item is REVIEW, and only a
 * clear search is CLEAR. Search is keyword based, so the result includes the exact query and links;
 * a person still reads them.
 *
 * No network calls happen in the pure functions, and the CLI never files anything. GitHub's search
 * API allows 10 requests/minute unauthenticated; use GITHUB_TOKEN for more.
 */

export interface HuntIssue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  html_url: string;
  isPullRequest: boolean;
  updatedAt?: string;
}

export interface DuplicateMatch {
  issue: HuntIssue;
  similarity: number;
  reason: string;
}

export type DedupeDecision = 'BLOCK' | 'REVIEW' | 'CLEAR';

export interface DedupeResult {
  repo: string;
  title: string;
  query: string;
  decision: DedupeDecision;
  matches: DuplicateMatch[];
  checked: number;
  error?: string;
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'to', 'of', 'in', 'on',
  'for', 'with', 'by', 'from', 'up', 'about', 'into', 'over', 'after', 'before', 'at', 'this', 'that', 'these',
  'those', 'it', 'its', 'as', 'not', 'no', 'can', 'cannot', "can't", 'does', 'do', 'did', 'when', 'then', 'than',
  'so', 'if', 'because', 'while', 'should', 'would', 'could', 'will', 'just', 'also', 'very', 'more', 'most',
  'page', 'test', 'tests', 'testing', 'bug', 'issue', 'error', 'breaks', 'broken', 'fail', 'fails', 'failing',
  'expected', 'actual', 'repro', 'steps', 'using', 'use', 'user', 'users', 'works', 'working', "doesn't", "isn't",
]);

/** Significant words from a title/body, lowercased, deduped, bounded. */
export function keywords(text: string, limit = 8): string[] {
  const words = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9@./:_-]+/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
  const seen = new Set<string>();
  const result: string[] = [];
  for (const word of words) {
    if (seen.has(word)) continue;
    seen.add(word);
    result.push(word);
    if (result.length >= limit) break;
  }
  return result;
}

function tokenSet(text: string): Set<string> {
  return new Set(keywords(text, 60));
}

/** Jaccard similarity over significant tokens; 0 for empty inputs. */
export function similarity(left: string, right: string): number {
  const a = tokenSet(left);
  const b = tokenSet(right);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Check one candidate against already-fetched issues. Pure and deterministic. */
export function scoreMatches(title: string, body: string, issues: HuntIssue[]): DuplicateMatch[] {
  const candidate = `${title}\n${body}`;
  const matches: DuplicateMatch[] = [];
  for (const issue of issues) {
    const titleScore = similarity(title, issue.title);
    const bodyScore = similarity(candidate, `${issue.title}\n${issue.body}`);
    const score = Math.max(titleScore, bodyScore * 0.9);
    if (score >= 0.35) {
      const reason =
        titleScore >= 0.55
          ? `title overlap ${(titleScore * 100).toFixed(0)}%`
          : `body overlap ${(bodyScore * 100).toFixed(0)}%`;
      matches.push({ issue, similarity: Number(score.toFixed(3)), reason });
    }
  }
  return matches.sort((a, b) => b.similarity - a.similarity).slice(0, 5);
}

export function decide(matches: DuplicateMatch[]): DedupeDecision {
  if (matches.some((match) => match.issue.state === 'open' && match.similarity >= 0.55)) return 'BLOCK';
  if (matches.some((match) => match.issue.state === 'open' && match.similarity >= 0.4)) return 'REVIEW';
  if (matches.some((match) => match.similarity >= 0.4)) return 'REVIEW';
  return 'CLEAR';
}

interface SearchResponse {
  total_count?: number;
  items?: Array<{ number: number; title: string; body?: string; state: string; html_url: string; updated_at?: string; pull_request?: unknown }>;
}

function searchQuery(repo: string, text: string): string {
  const words = keywords(text, 6).map((word) => `"${word}"`).join(' ');
  return `repo:${repo} ${words} in:title,body`;
}

/** Fetch candidate duplicate issues/PRs from GitHub. Never throws; returns an error field instead. */
export async function findDuplicates(
  repo: string,
  title: string,
  body: string,
  options: { fetchImpl?: typeof fetch; token?: string; perPage?: number } = {},
): Promise<DedupeResult> {
  const fetchImpl = options.fetchImpl || fetch;
  const token = options.token || process.env.GITHUB_TOKEN;
  const query = searchQuery(repo, `${title}\n${body}`);
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'qafind-hunt' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const issues: HuntIssue[] = [];
  let error: string | undefined;
  try {
    const url = `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&per_page=${options.perPage || 10}&sort=updated`;
    const response = await fetchImpl(url, { headers });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      error = `GitHub search failed (HTTP ${response.status})${text ? `: ${text.slice(0, 160)}` : ''}`;
    } else {
      const payload = (await response.json()) as SearchResponse;
      for (const item of payload.items || []) {
        issues.push({
          number: item.number,
          title: item.title,
          body: item.body || '',
          state: item.state === 'open' ? 'open' : 'closed',
          html_url: item.html_url,
          isPullRequest: Boolean(item.pull_request),
          updatedAt: item.updated_at,
        });
      }
    }
  } catch (cause) {
    error = `GitHub search failed: ${cause instanceof Error ? cause.message : String(cause)}`;
  }
  const matches = error ? [] : scoreMatches(title, body, issues);
  return { repo, title, query, decision: error ? 'REVIEW' : decide(matches), matches, checked: issues.length, ...(error ? { error } : {}) };
}

export function renderDedupeReport(result: DedupeResult): string {
  const lines = [
    `# Duplicate gate: ${result.decision}`,
    '',
    `- Repository: \`${result.repo}\``,
    `- Candidate: ${result.title}`,
    `- Query: \`${result.query.replace(/`/g, '')}\``,
    `- Checked: ${result.checked} issue(s)/PR(s)`,
    '',
  ];
  if (result.error) {
    lines.push(`**Gate incomplete:** ${result.error}`, '');
    lines.push('Do not file anything until this is resolved (set `GITHUB_TOKEN` or retry later).');
  } else if (result.matches.length === 0) {
    lines.push('No similar open or closed issue/PR was found by this keyword search. Re-check manually with the target URL and error text before filing.');
  } else {
    lines.push('| Similarity | State | Issue/PR | Why |', '| ---: | :--- | :--- | :--- |');
    for (const match of result.matches) {
      lines.push(
        `| ${(match.similarity * 100).toFixed(0)}% | ${match.issue.state}${match.issue.isPullRequest ? ' (PR)' : ''} | [#${match.issue.number}](${match.issue.html_url}) ${match.issue.title.replace(/\|/g, '\\|')} | ${match.reason} |`,
      );
    }
    lines.push('');
    lines.push(
      result.decision === 'BLOCK'
        ? '**Blocked:** an open item already covers this. Add evidence to it instead of opening a new report.'
        : result.decision === 'REVIEW'
          ? '**Review before filing:** a related item exists. Read it and state why this is not a duplicate, or add to it.'
          : 'No strong duplicate, but read the matches before filing.',
    );
  }
  return lines.join('\n');
}
