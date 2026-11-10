/**
 * Evidence certificates: check what a signed bundle actually proves, not just who signed it.
 *
 * `AttestationEngine.verifyBundle` answers "is this record authentic and unchanged since
 * signing?". A signature proves *who* wrote a bundle; it does not prove the bundle is a
 * complete and self-consistent account of the run. A signer can sign a summary whose counts
 * do not match the ledger it ships with, or a bundle that still contains a real secret.
 *
 * This module adds five offline properties over a `ComplianceProofBundle`:
 *
 *   P1 chain      — every block links to its predecessor and indices are gapless.
 *   P2 merkle     — every block is a leaf under the signed root, and the root recomputes.
 *   P3 summary    — every claimed count is recomputable from the signed ledger.
 *   P4 secrets    — no configured real secret value appears anywhere in the bundle.
 *   P5 replay     — a second, independent run of the same workflow reproduces the actions.
 *
 * Each property is PASS, FAIL or NOT_CHECKED, never an inference. P5 needs a second bundle,
 * and P4 needs the caller to supply the secret values to look for, so both report NOT_CHECKED
 * when that input is missing instead of silently passing. `--strict` turns "not checked" into
 * a failure so CI cannot treat an unchecked bundle as certified.
 *
 * The caller is expected to verify the bundle's signature first. These checks are
 * defence-in-depth for the signing path, not a replacement for it.
 */
import type { ComplianceProofBundle, LedgerBlock } from '../types/index.js';
import { AirlockLedger } from './ledger.js';
import { MerkleTree } from './merkle-tree.js';
import { canonicalJson, sha256 } from '../utils/crypto.js';

export type CertificateStatus = 'PASS' | 'FAIL' | 'NOT_CHECKED';
export type CertificateId = 'P1' | 'P2' | 'P3' | 'P4' | 'P5';

export const CERTIFICATE_IDS: readonly CertificateId[] = ['P1', 'P2', 'P3', 'P4', 'P5'];

/**
 * Shortest secret value worth scanning for. Below this length a substring search matches
 * incidental text and produces false failures, so the value is skipped (and reported).
 */
export const MIN_SECRET_SCAN_LENGTH = 8;

export interface CertificateCheck {
  id: CertificateId;
  name: string;
  status: CertificateStatus;
  /** Human-readable result. Never contains secret values. */
  detail: string;
  evidence?: Record<string, unknown>;
}

export interface CertificateReport {
  runId: string;
  bundleSpecVersion: string;
  checkedAt: string;
  checks: CertificateCheck[];
  passed: number;
  failed: number;
  notChecked: number;
  total: number;
  /** No property failed. */
  ok: boolean;
  /** Every property was actually checked and passed. This is the only state that is a certificate. */
  failClosed: boolean;
}

export interface ForbiddenValue {
  name: string;
  value: string;
  source?: string;
}

export interface SecretEntry {
  real?: string;
  realFromEnv?: string;
  phantom?: string;
}

export interface ResolvedSecretValues {
  values: ForbiddenValue[];
  /** Values that could not be scanned, with the reason. Named so the report can be honest. */
  skipped: Array<{ name: string; reason: string }>;
}

export interface CertificateOptions {
  /** Real secret values that must not appear in the bundle. Resolve these from the operator's config + env. */
  forbiddenValues?: ForbiddenValue[];
  /** A second bundle from an independent re-run of the same workflow, for P5. */
  replayBundle?: ComplianceProofBundle;
  /** Cap on per-leaf Merkle proofs (the root always covers every leaf). Defaults to 2000. */
  maxLeafProofs?: number;
}

const DEFAULT_MAX_LEAF_PROOFS = 2000;

/**
 * Resolve the real secret values a bundle must not contain.
 *
 * `realFromEnv` wins over `real`, matching the runner's substitution order. A missing
 * environment variable or a value shorter than {@link MIN_SECRET_SCAN_LENGTH} is skipped and
 * reported rather than treated as "nothing to check".
 */
export function resolveRealSecretValues(
  secrets: Record<string, SecretEntry> | undefined,
  env: Record<string, string | undefined> = process.env
): ResolvedSecretValues {
  const values: ForbiddenValue[] = [];
  const skipped: ResolvedSecretValues['skipped'] = [];
  const seen = new Set<string>();

  for (const [name, entry] of Object.entries(secrets ?? {})) {
    if (!entry || typeof entry !== 'object') {
      skipped.push({ name, reason: 'secret entry is not an object' });
      continue;
    }

    let value: string | undefined;
    let source: 'env' | 'config' = 'config';

    if (typeof entry.realFromEnv === 'string' && entry.realFromEnv.trim()) {
      const envName = entry.realFromEnv.trim();
      const fromEnv = env[envName];
      if (typeof fromEnv !== 'string' || fromEnv.trim() === '') {
        skipped.push({ name, reason: `environment variable ${envName} is not set` });
        continue;
      }
      value = fromEnv.trim();
      source = 'env';
    } else if (typeof entry.real === 'string' && entry.real.trim() !== '') {
      value = entry.real.trim();
    }

    if (value === undefined) {
      skipped.push({ name, reason: 'no real value configured (neither real nor realFromEnv)' });
      continue;
    }
    if (value.length < MIN_SECRET_SCAN_LENGTH) {
      skipped.push({ name, reason: `value is shorter than ${MIN_SECRET_SCAN_LENGTH} characters, skipping to avoid false matches` });
      continue;
    }
    if (seen.has(value)) {
      skipped.push({ name, reason: 'duplicate of another configured secret value' });
      continue;
    }

    seen.add(value);
    values.push({ name, value, source: `${source}:${source === 'env' ? entry.realFromEnv!.trim() : 'real'}` });
  }

  return { values, skipped };
}

function blocksOf(bundle: ComplianceProofBundle): LedgerBlock[] {
  return Array.isArray(bundle?.ledgerBlocks) ? bundle.ledgerBlocks : [];
}

function countBlocks(blocks: LedgerBlock[], type: LedgerBlock['type']): number {
  return blocks.filter((block) => block.type === type).length;
}

function isHex64(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function check(
  id: CertificateId,
  name: string,
  status: CertificateStatus,
  detail: string,
  evidence?: Record<string, unknown>
): CertificateCheck {
  return { id, name, status, detail, ...(evidence ? { evidence } : {}) };
}

/** P1: the ledger is a gapless hash chain from genesis to the last block. */
export function checkChainIntegrity(bundle: ComplianceProofBundle): CertificateCheck {
  const blocks = blocksOf(bundle);
  if (blocks.length === 0) {
    return check('P1', 'Hash-chain integrity', 'FAIL', 'Bundle contains no ledger blocks');
  }

  const chain = AirlockLedger.verifyBlocks(blocks);
  if (!chain.valid) {
    return check('P1', 'Hash-chain integrity', 'FAIL', chain.reason ?? 'Ledger hash chain is invalid', {
      tamperedIndex: chain.tamperedIndex ?? null,
    });
  }

  if (bundle.ledgerVerificationStatus !== 'VALID_CHAIN') {
    return check(
      'P1',
      'Hash-chain integrity',
      'FAIL',
      `Bundle claims ledgerVerificationStatus=${JSON.stringify(bundle.ledgerVerificationStatus)} while the embedded chain is valid`
    );
  }

  return check(
    'P1',
    'Hash-chain integrity',
    'PASS',
    `Recomputed ${blocks.length} blocks from genesis; every previousHash pointer and blockHash matches`,
    { blocks: blocks.length }
  );
}

/** P2: every ledger block is a leaf under the signed Merkle root, and the root recomputes. */
export function checkMerkleInclusion(
  bundle: ComplianceProofBundle,
  maxLeafProofs: number = DEFAULT_MAX_LEAF_PROOFS
): CertificateCheck {
  const blocks = blocksOf(bundle);
  if (blocks.length === 0) {
    return check('P2', 'Merkle inclusion', 'FAIL', 'Bundle contains no ledger blocks');
  }

  const leafHashes = blocks.map((block) => block.blockHash);
  if (leafHashes.some((hash) => !isHex64(hash))) {
    return check('P2', 'Merkle inclusion', 'FAIL', 'One or more ledger blocks has a malformed blockHash');
  }

  const tree = new MerkleTree(leafHashes);
  const recomputedRoot = tree.getRoot();
  if (recomputedRoot !== bundle.merkleRoot) {
    return check(
      'P2',
      'Merkle inclusion',
      'FAIL',
      `Merkle root mismatch: bundle says ${bundle.merkleRoot}, the embedded ledger gives ${recomputedRoot}`
    );
  }

  const cap = Math.max(1, Math.min(maxLeafProofs, leafHashes.length));
  let proved = 0;
  for (let index = 0; index < cap; index++) {
    const proof = tree.getProof(index);
    if (!MerkleTree.verifyProof(leafHashes[index], proof, recomputedRoot)) {
      return check('P2', 'Merkle inclusion', 'FAIL', `Inclusion proof failed for ledger block ${index}`);
    }
    proved++;
  }

  return check(
    'P2',
    'Merkle inclusion',
    'PASS',
    proved === leafHashes.length
      ? `Root recomputed from the ledger; inclusion proof verified for all ${proved} blocks`
      : `Root recomputed from the ledger; inclusion proof verified for ${proved} of ${leafHashes.length} blocks (sampled)`,
    { leaves: leafHashes.length, provenLeaves: proved }
  );
}

interface Mismatch {
  field: string;
  claimed: unknown;
  derived: unknown;
}

/** P3: every count the bundle claims can be recomputed from the signed ledger. */
export function checkSummaryDerivability(bundle: ComplianceProofBundle): CertificateCheck {
  const blocks = blocksOf(bundle);
  if (blocks.length === 0) {
    return check('P3', 'Summary derivable from ledger', 'FAIL', 'Bundle contains no ledger blocks');
  }
  if (!bundle.summary || !bundle.policyAudit) {
    return check('P3', 'Summary derivable from ledger', 'FAIL', 'Bundle is missing summary or policyAudit');
  }

  const allowedIntercepts = blocks.filter(
    (block) => block.type === 'PROXY_INTERCEPT' && (block.payload as { verdict?: unknown }).verdict !== 'BLOCKED'
  ).length;
  const blockedEgress = countBlocks(blocks, 'EGRESS_BLOCKED');
  const blockedMutations = blocks.filter(
    (block) => block.type === 'EGRESS_BLOCKED' && ['POST', 'PUT', 'DELETE'].includes(String((block.payload as { method?: unknown }).method ?? '').toUpperCase())
  ).length;
  const dispatched = countBlocks(blocks, 'ACTION_DISPATCH');

  const mismatches: Mismatch[] = [];
  const compare = (field: string, claimed: unknown, derived: number) => {
    if (claimed !== derived) mismatches.push({ field, claimed, derived });
  };

  compare('blocksCount', bundle.blocksCount, blocks.length);
  compare('summary.totalSteps', bundle.summary.totalSteps, dispatched);
  compare('policyAudit.egressAllowedCount', bundle.policyAudit.egressAllowedCount, allowedIntercepts);
  compare('policyAudit.egressBlockedCount', bundle.policyAudit.egressBlockedCount, blockedEgress);
  compare('policyAudit.unauthorizedMutationsPrevented', bundle.policyAudit.unauthorizedMutationsPrevented, blockedMutations);

  // Fields that assert a measurement the ledger cannot substantiate must stay null.
  const unsubstantiated: string[] = [];
  if (bundle.summary.passedSteps !== null) unsubstantiated.push('summary.passedSteps');
  if (bundle.summary.failedSteps !== null) unsubstantiated.push('summary.failedSteps');
  if (bundle.policyAudit.realSecretsExposedToSandbox !== null) unsubstantiated.push('policyAudit.realSecretsExposedToSandbox');

  if (mismatches.length > 0) {
    const summary = mismatches.map((m) => `${m.field} claims ${JSON.stringify(m.claimed)}, ledger gives ${m.derived}`).join('; ');
    return check('P3', 'Summary derivable from ledger', 'FAIL', summary, { mismatches, unsubstantiated });
  }
  if (unsubstantiated.length > 0) {
    return check(
      'P3',
      'Summary derivable from ledger',
      'FAIL',
      `Bundle claims values the ledger cannot substantiate: ${unsubstantiated.join(', ')}`,
      { mismatches, unsubstantiated }
    );
  }

  return check(
    'P3',
    'Summary derivable from ledger',
    'PASS',
    `All 5 derived counts match the embedded ledger (${dispatched} actions, ${allowedIntercepts} allowed, ${blockedEgress} blocked, ${blockedMutations} mutations prevented)`,
    { dispatched, allowedIntercepts, blockedEgress, blockedMutations }
  );
}

/** P4: no configured real secret value appears anywhere in the bundle. */
export function checkSecretFreedom(bundle: ComplianceProofBundle, forbiddenValues: ForbiddenValue[] = []): CertificateCheck {
  if (forbiddenValues.length === 0) {
    return check(
      'P4',
      'Secret freedom',
      'NOT_CHECKED',
      'No real secret values were available to scan for (configure a secret, or set its realFromEnv variable, then re-run)'
    );
  }

  let haystack: string;
  try {
    haystack = canonicalJson(bundle);
  } catch (error) {
    return check('P4', 'Secret freedom', 'FAIL', `Bundle cannot be canonicalised for scanning: ${(error as Error).message}`);
  }

  const leaked = forbiddenValues.filter((entry) => haystack.includes(entry.value));
  if (leaked.length > 0) {
    // Never print the value itself, only the configured name.
    return check(
      'P4',
      'Secret freedom',
      'FAIL',
      `Configured real secret value(s) appear in the bundle: ${leaked.map((entry) => entry.name).join(', ')}`,
      { leakedNames: leaked.map((entry) => entry.name) }
    );
  }

  return check(
    'P4',
    'Secret freedom',
    'PASS',
    `None of the ${forbiddenValues.length} configured real secret value(s) appears anywhere in the bundle`,
    { scanned: forbiddenValues.length }
  );
}

/** Stable per-block fingerprint used to compare two runs without comparing timestamps. */
function orderedPayloadFingerprint(blocks: LedgerBlock[], type: LedgerBlock['type']): string[] {
  return blocks
    .filter((block) => block.type === type)
    .map((block) => sha256(canonicalJson({ type: block.type, payload: block.payload })));
}

function firstDivergence(a: string[], b: string[]): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    if (a[index] !== b[index]) return index;
  }
  return length;
}

/** P5: an independent re-run reproduces the same action and assertion sequence. */
export function checkReplayDeterminism(
  bundle: ComplianceProofBundle,
  replayBundle?: ComplianceProofBundle
): CertificateCheck {
  if (!replayBundle) {
    return check(
      'P5',
      'Replay determinism',
      'NOT_CHECKED',
      'No second bundle supplied; determinism cannot be checked offline (pass --against <bundle> with an independent re-run)'
    );
  }
  if (replayBundle.runId === bundle.runId) {
    return check(
      'P5',
      'Replay determinism',
      'NOT_CHECKED',
      `The supplied --against bundle is the same run (${bundle.runId}), not an independent re-run`
    );
  }

  const actions = orderedPayloadFingerprint(blocksOf(bundle), 'ACTION_DISPATCH');
  const replayActions = orderedPayloadFingerprint(blocksOf(replayBundle), 'ACTION_DISPATCH');
  if (actions.length === 0 || replayActions.length === 0) {
    return check('P5', 'Replay determinism', 'NOT_CHECKED', 'One of the bundles contains no dispatched actions to compare');
  }

  const actionDivergence = firstDivergence(actions, replayActions);
  if (actionDivergence < actions.length || actions.length !== replayActions.length) {
    return check(
      'P5',
      'Replay determinism',
      'FAIL',
      `Action sequences diverge at step ${actionDivergence + 1} (${actions.length} vs ${replayActions.length} actions)`,
      { divergenceIndex: actionDivergence, baselineActions: actions.length, replayActions: replayActions.length }
    );
  }

  const assertions = orderedPayloadFingerprint(blocksOf(bundle), 'ASSERTION_EVAL');
  const replayAssertions = orderedPayloadFingerprint(blocksOf(replayBundle), 'ASSERTION_EVAL');
  const assertionDivergence = firstDivergence(assertions, replayAssertions);
  if (assertions.length !== replayAssertions.length || assertionDivergence < assertions.length) {
    return check(
      'P5',
      'Replay determinism',
      'FAIL',
      `Assertion outcomes diverge at step ${assertionDivergence + 1} (${assertions.length} vs ${replayAssertions.length} assertions)`
    );
  }

  return check(
    'P5',
    'Replay determinism',
    'PASS',
    `Independent re-run ${replayBundle.runId} reproduces all ${actions.length} actions and ${assertions.length} assertions`,
    { actions: actions.length, assertions: assertions.length, replayRunId: replayBundle.runId }
  );
}

/**
 * Run every certificate property. Never throws: an unexpected failure becomes a FAIL for the
 * affected property. The caller decides the exit code (`failed > 0`, or `notChecked > 0` when strict).
 */
export function checkCertificates(bundle: ComplianceProofBundle, options: CertificateOptions = {}): CertificateReport {
  const checks: CertificateCheck[] = [];
  const guarded = (id: CertificateId, name: string, run: () => CertificateCheck): CertificateCheck => {
    try {
      return run();
    } catch (error) {
      return check(id, name, 'FAIL', `Certificate check crashed: ${(error as Error).message}`);
    }
  };

  checks.push(guarded('P1', 'Hash-chain integrity', () => checkChainIntegrity(bundle)));
  checks.push(guarded('P2', 'Merkle inclusion', () => checkMerkleInclusion(bundle, options.maxLeafProofs)));
  checks.push(guarded('P3', 'Summary derivable from ledger', () => checkSummaryDerivability(bundle)));
  checks.push(guarded('P4', 'Secret freedom', () => checkSecretFreedom(bundle, options.forbiddenValues)));
  checks.push(guarded('P5', 'Replay determinism', () => checkReplayDeterminism(bundle, options.replayBundle)));

  const passed = checks.filter((entry) => entry.status === 'PASS').length;
  const failed = checks.filter((entry) => entry.status === 'FAIL').length;
  const notChecked = checks.filter((entry) => entry.status === 'NOT_CHECKED').length;

  return {
    runId: typeof bundle?.runId === 'string' ? bundle.runId : 'unknown',
    bundleSpecVersion: typeof bundle?.specVersion === 'string' ? bundle.specVersion : 'unknown',
    checkedAt: new Date().toISOString(),
    checks,
    passed,
    failed,
    notChecked,
    total: checks.length,
    ok: failed === 0,
    failClosed: failed === 0 && notChecked === 0,
  };
}
