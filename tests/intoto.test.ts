import { describe, expect, test } from 'bun:test';
import { signInTotoStatement, verifyInTotoEnvelope } from '../src/compliance/intoto.js';

const statement = {
  _type: 'https://in-toto.io/Statement/v1' as const,
  subject: [{ name: 'owner/repo', digest: { sha1: 'a'.repeat(40) } }],
  predicateType: 'https://in-toto.io/attestation/test-result/v0.1' as const,
  predicate: { result: 'FAILED', summary: { regressions: 1 } },
};

describe('signed in-toto/DSSE attestations', () => {
  test('signs and verifies an HMAC envelope offline', () => {
    const key = 'in-toto-test-signing-key-32-characters';
    const envelope = signInTotoStatement(statement, { signingKey: key });
    expect(envelope.payloadType).toBe('application/vnd.in-toto+json');
    const result = verifyInTotoEnvelope(envelope, { signingKey: key });
    expect(result.valid).toBe(true);
    expect(result.statement?.predicate.result).toBe('FAILED');
    expect(verifyInTotoEnvelope(envelope, { signingKey: 'wrong-key-at-least-32-characters-long' }).valid).toBe(false);
  });

  test('rejects a tampered payload and a bad type', () => {
    const key = 'in-toto-test-signing-key-32-characters';
    const envelope = signInTotoStatement(statement, { signingKey: key });
    const tampered = JSON.parse(JSON.stringify(envelope));
    tampered.payload = Buffer.from(JSON.stringify({ ...statement, predicate: { result: 'PASSED' } })).toString('base64');
    expect(verifyInTotoEnvelope(tampered, { signingKey: key }).valid).toBe(false);
    expect(verifyInTotoEnvelope({ ...envelope, payloadType: 'application/json' }, { signingKey: key }).valid).toBe(false);
  });
});
