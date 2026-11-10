/**
 * Markdown for a PR comment / CI summary. Deterministic: no timestamps, no generated-at line, so
 * two analyses of the same reports render the same bytes. Every value comes from the analysis.
 */
import { FLAKE_CLASSIFICATIONS, type FlakeAnalysis, type FlakeTestSummary } from './types.js';

function cell(value: string): string {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim();
}

function displayName(test: FlakeTestSummary): string {
  if (test.titlePath.length > 0) return test.titlePath.join(' › ');
  return test.title || test.id;
}

export function renderFlakeMarkdown(analysis: FlakeAnalysis): string {
  const ledgerBacked = analysis.tests.filter(
    (test) => test.evidenceTier === 'request-ledger' && test.ledger !== undefined && (test.ledger.requests > 0 || test.ledger.failures > 0),
  );
  const lines: string[] = [];
  lines.push('# Flake analysis', '');
  lines.push(`- Reports analyzed: ${analysis.reports}`);
  lines.push(`- Tests: ${analysis.totalTests}`);
  lines.push(`- Flaky tests: ${analysis.flakyTests}`);
  lines.push(`- Quarantined: ${analysis.quarantine.length}`);
  lines.push(`- Minimum runs: ${analysis.minRuns}`);
  lines.push('');

  lines.push('## Totals', '');
  for (const classification of FLAKE_CLASSIFICATIONS) {
    lines.push(`- ${classification}: ${analysis.totals[classification] ?? 0}`);
  }
  lines.push('');

  lines.push('## Tests', '');
  lines.push('| Test | File | Runs | Flakes | Cause | Owner | Quarantine |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  if (analysis.tests.length === 0) {
    lines.push('| _No tests recorded_ | — | 0 | 0 | unknown | — | no |');
  } else {
    for (const test of analysis.tests) {
      lines.push(
        `| ${cell(displayName(test))} | ${cell(test.file) || '—'} | ${test.runs} | ${test.flakeCount} | ${test.classification} | ${cell(test.owner ?? '') || '—'} | ${test.quarantined ? 'yes' : 'no'} |`
      );
    }
  }
  lines.push('');

  if (ledgerBacked.length) {
    lines.push('## Request-ledger evidence', '');
    lines.push('These causes are backed by the recorded attach request ledger, not just error text:');
    lines.push('');
    for (const test of ledgerBacked) {
      const ledger = test.ledger;
      lines.push(
        `- ${cell(displayName(test))} — ${test.classification} (${ledger ? `${ledger.requests} request(s), ${ledger.failures} failure(s), ${ledger.missing} missing replay` : 'ledger present'})`,
      );
    }
    lines.push('');
  }

  lines.push('## Warnings', '');
  if (analysis.warnings.length === 0) {
    lines.push('- None.');
  } else {
    for (const warning of analysis.warnings) lines.push(`- ${cell(warning)}`);
  }
  lines.push('');
  return lines.join('\n');
}
