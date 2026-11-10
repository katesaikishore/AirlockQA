/**
 * `airlock flake` engine (P0): deterministic flake detection, classification and quarantine from
 * the reporter manifests in src/testing/airlock-report.ts.
 *
 * This module has no CLI wiring, no network and no signing. `airlock flake` (or the reporter's PR
 * comment) decides how to print JSON/Markdown and how to exit CI.
 */
export * from './types.js';
export { analyzeFlakiness } from './analyze.js';
export { renderFlakeMarkdown } from './markdown.js';
export { classifyErrorText, classifyErrors, redactEvidenceText, FLAKE_ORDER } from './classify.js';

export { readFlakeLedgers, applyLedgerEvidence, type FlakeLedger } from './ledger.js';
