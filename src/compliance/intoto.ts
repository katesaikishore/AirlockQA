/**
 * Signed in-toto test-result attestations (DSSE envelope).
 *
 * A Verified Merge verdict is signed so the JSON cannot be edited. This module wraps the same evidence
 * in a standard in-toto Statement and DSSE envelope, so customers and auditors can verify it with
 * generic in-toto tooling or `airlock verify-intoto` without trusting the Airlock service.
 */
import { resolveSigningKey, type SigningAlgorithm } from './attestation.js';
import { canonicalJson, ed25519KeyId, ed25519PublicKeyPem, sha256, signEd25519, signHmac, verifyEd25519, verifyHmac } from '../utils/crypto.js';

export const DSSE_PAYLOAD_TYPE = 'application/vnd.in-toto+json' as const;
export const INTOTO_STATEMENT_TYPE = 'https://in-toto.io/Statement/v1' as const;
export const INTOTO_TEST_RESULT_TYPE = 'https://in-toto.io/attestation/test-result/v0.1' as const;

export interface InTotoStatement {
  _type: typeof INTOTO_STATEMENT_TYPE;
  subject: Array<{ name: string; digest: Record<string, string> }>;
  predicateType: typeof INTOTO_TEST_RESULT_TYPE;
  predicate: Record<string, unknown>;
}

export interface DsseSignature {
  keyid: string;
  sig: string;
}

export interface DsseEnvelope {
  payloadType: typeof DSSE_PAYLOAD_TYPE;
  payload: string;
  signatures: DsseSignature[];
}

export interface SigningOptions {
  signingKey?: string;
  env?: Record<string, string | undefined>;
}

export interface VerifyOptions {
  signingKey?: string;
  publicKeyPem?: string;
  env?: Record<string, string | undefined>;
}

function keyId(algorithm: SigningAlgorithm, key: string): string {
  return algorithm === 'Ed25519' ? ed25519KeyId(ed25519PublicKeyPem(key)) : `hmac:${sha256(key).slice(0, 16)}`;
}

/** Sign an in-toto Statement into a DSSE envelope. Refuses the insecure development key. */
export function signInTotoStatement(statement: InTotoStatement, options: SigningOptions = {}): DsseEnvelope {
  if (!statement || statement._type !== INTOTO_STATEMENT_TYPE) throw new Error('Not an in-toto Statement v1');
  const resolved = resolveSigningKey(options.signingKey, options.env || process.env);
  if (resolved.isDevKey) throw new Error('Refusing to sign in-toto evidence with the development key; set AIRLOCK_SIGNING_KEY');
  const payload = Buffer.from(canonicalJson(statement), 'utf8').toString('base64');
  const sig = resolved.algorithm === 'Ed25519'
    ? signEd25519(payload, resolved.key)
    : Buffer.from(signHmac(payload, resolved.key), 'hex').toString('base64');
  return { payloadType: DSSE_PAYLOAD_TYPE, payload, signatures: [{ keyid: keyId(resolved.algorithm, resolved.key), sig }] };
}

export interface VerifyDsseResult {
  valid: boolean;
  reason?: string;
  statement: InTotoStatement | null;
  algorithm: SigningAlgorithm | null;
  keyid: string | null;
}

/** Verify a DSSE in-toto envelope and return the parsed statement only when the signature is valid. */
export function verifyInTotoEnvelope(envelope: unknown, options: VerifyOptions = {}): VerifyDsseResult {
  try {
    const value = envelope as Partial<DsseEnvelope>;
    if (!value || value.payloadType !== DSSE_PAYLOAD_TYPE) return { valid: false, reason: 'unsupported DSSE payloadType', statement: null, algorithm: null, keyid: null };
    if (typeof value.payload !== 'string' || !Array.isArray(value.signatures) || !value.signatures.length) return { valid: false, reason: 'DSSE payload or signature is missing', statement: null, algorithm: null, keyid: null };
    const raw = Buffer.from(value.payload, 'base64').toString('utf8');
    const statement = JSON.parse(raw) as InTotoStatement;
    if (statement?._type !== INTOTO_STATEMENT_TYPE) return { valid: false, reason: 'payload is not an in-toto Statement v1', statement: null, algorithm: null, keyid: null };
    for (const signature of value.signatures) {
      if (!signature || typeof signature.keyid !== 'string' || typeof signature.sig !== 'string') continue;
      if (signature.keyid.startsWith('ed25519:')) {
        if (!options.publicKeyPem) continue;
        if (verifyEd25519(value.payload, signature.sig, options.publicKeyPem)) return { valid: true, statement, algorithm: 'Ed25519', keyid: signature.keyid };
      } else if (signature.keyid.startsWith('hmac:')) {
        const resolved = resolveSigningKey(options.signingKey, options.env || process.env);
        if (!resolved.isDevKey && resolved.algorithm === 'HMAC-SHA256') {
          const hex = Buffer.from(signature.sig, 'base64').toString('hex');
          if (verifyHmac(value.payload, hex, resolved.key)) return { valid: true, statement, algorithm: 'HMAC-SHA256', keyid: signature.keyid };
        }
      }
    }
    return { valid: false, reason: 'no signature matched the configured key', statement, algorithm: null, keyid: null };
  } catch (error) {
    return { valid: false, reason: error instanceof Error ? error.message : String(error), statement: null, algorithm: null, keyid: null };
  }
}
