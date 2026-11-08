import { useCallback, useEffect, useState } from 'react';
import { useApp, useSessionState } from '../app-context';
import { formatDateTime, shortId } from '../lib';
import { Card, CodeBlock, CopyButton, ErrorBox, Loading, PageHeader, RetryBlock, StatusPill } from '../ui';
import type { RunSummary } from '../types';
import { shortRepo, verifyQaSeal, type QaRunSummary, type SealCheck } from '../qa';

interface KeyInfo { keyId?: string; algorithm?: string; publicKeyPem?: string }
interface VerifyBody { valid?: boolean; reason?: unknown; warnings?: unknown }
const NO_OUTCOMES: Record<string, Outcome> = {};
type Outcome = { kind: 'pending' } | { kind: 'error'; error: unknown } | { kind: 'done'; result: VerifyBody };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function SigningKey() {
  const { api, call } = useApp();
  const [info, setInfo] = useState<KeyInfo | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(async () => {
    setInfo(null);
    setError(null);
    try {
      setInfo(asRecord(await call(() => api.evidenceKey())) as KeyInfo);
    } catch (caught) {
      setError(caught);
    }
  }, [api, call]);
  useEffect(() => { void load(); }, [load]);

  if (error) return <RetryBlock error={error} retry={() => { void load(); }} />;
  if (!info) return <Loading text="Loading signing key" />;
  const pem = info.publicKeyPem || '';
  const keyId = info.keyId || '';
  return (
    <div id="evidence-key">
      <dl className="lv-meta">
        <div className="lv-meta-item">
          <dt>Key id</dt>
          <dd><span className="lv-mono lv-wrap" id="evidence-key-id">{keyId}</span> <CopyButton label="Copy key id" getText={() => keyId} /></dd>
        </div>
        <div className="lv-meta-item"><dt>Algorithm</dt><dd>{info.algorithm}</dd></div>
      </dl>
      <p className="lv-small lv-muted">Public key</p>
      <div className="lv-code-wrap lv-code-multi">
        <pre className="lv-code" id="evidence-public-key" tabIndex={0}><code>{pem}</code></pre>
        <CopyButton label="Copy public key" getText={() => pem} />
      </div>
      <p className="lv-small lv-muted">Check a bundle on your machine. Pin the public key above so the check does not trust the bundle&apos;s own key:</p>
      <CodeBlock text="AIRLOCK_TRUSTED_PUBLIC_KEY=... airlock audit <bundle.json>" />
      <div className="lv-actions">
        <CopyButton label="Copy command with this key" getText={() => "AIRLOCK_TRUSTED_PUBLIC_KEY='" + pem.trim() + "' airlock audit <bundle.json>"} />
      </div>
      <p className="lv-small lv-muted">A valid bundle shows the recorded ledger was not changed after signing. It does not show that the target application is secure and is not a compliance assessment.</p>
    </div>
  );
}

function VerifyResult({ outcome }: { outcome: Outcome }) {
  if (outcome.kind === 'pending') return <p className="lv-muted">Verifying…</p>;
  if (outcome.kind === 'error') return <ErrorBox error={outcome.error} />;
  const result = outcome.result;
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  return (
    <div className={'lv-alert ' + (result.valid ? 'lv-alert-ok' : 'lv-alert-error')} data-verify-result={result.valid ? 'valid' : 'invalid'}>
      <strong>{result.valid ? 'Valid' : 'Invalid'}</strong>
      {result.reason ? <p className="lv-wrap">{String(result.reason)}</p> : null}
      {warnings.length ? <ul>{warnings.map((warning, index) => <li key={index}>{String(warning)}</li>)}</ul> : null}
      <p className="lv-small lv-muted">Checked by the service against its signing key.</p>
    </div>
  );
}

function EvidenceList() {
  const { api, call, announce } = useApp();
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [outcomes, setOutcomes] = useSessionState<Record<string, Outcome>>('verify-outcomes', NO_OUTCOMES);

  const load = useCallback(async () => {
    setRuns(null);
    setError(null);
    try {
      const result = await call(() => api.runs.list({ limit: 50 }));
      setRuns(result.runs || []);
    } catch (caught) {
      setError(caught);
    }
  }, [api, call]);
  useEffect(() => { void load(); }, [load]);

  const verify = async (run: RunSummary) => {
    setOutcomes((current) => ({ ...current, [run.id]: { kind: 'pending' } }));
    let outcome: Outcome;
    try {
      const bundle = await call(() => api.runs.evidence(run.id));
      const result = asRecord(await call(() => api.verifyEvidence(bundle))) as VerifyBody;
      outcome = { kind: 'done', result };
      announce('Evidence for ' + run.suiteName + ' is ' + (result.valid ? 'valid' : 'invalid'));
    } catch (caught) {
      outcome = { kind: 'error', error: caught };
    }
    setOutcomes((current) => ({ ...current, [run.id]: outcome }));
  };

  if (error) return <RetryBlock error={error} retry={() => { void load(); }} />;
  if (!runs) return <Loading text="Loading runs" />;
  const withEvidence = runs.filter((run) => run.hasEvidence);
  if (withEvidence.length === 0) {
    return (
      <div className="lv-empty" id="evidence-empty">
        <p className="lv-muted">No finished runs have evidence yet. Evidence is signed when a cloud run finishes.</p>
        <a href="#runs/new" className="lv-btn lv-btn-primary">Start a cloud run</a>
      </div>
    );
  }
  return (
    <ul className="lv-evidence-list">
      {withEvidence.map((run) => {
        const outcome = outcomes[run.id];
        const pending = outcome !== undefined && outcome.kind === 'pending';
        return (
          <li className="lv-evidence-item" key={run.id}>
            <div className="lv-evidence-row">
              <div className="lv-evidence-main">
                <a href={'#run-detail/' + encodeURIComponent(run.id)} className="lv-link lv-run-link">{run.suiteName}</a>
                <div className="lv-small lv-muted">
                  <StatusPill status={run.status} /> {formatDateTime(run.finishedAt || run.createdAt)} · <span className="lv-mono">{shortId(run.id)}</span>
                </div>
              </div>
              <button
                type="button" className="lv-btn lv-btn-small" data-verify={run.id} aria-label={'Verify evidence for ' + run.suiteName}
                disabled={pending} aria-busy={pending ? 'true' : undefined} onClick={() => { void verify(run); }}
              >Verify</button>
            </div>
            <div className="lv-verify-slot" aria-live="polite">{outcome ? <VerifyResult outcome={outcome} /> : null}</div>
          </li>
        );
      })}
    </ul>
  );
}

const SEAL_LABEL: Record<SealCheck['state'], string> = {
  verified: 'Verified in this browser',
  invalid: 'Signature does not match',
  unavailable: 'Not checked in this browser',
  unsupported: 'Unsupported algorithm',
  missing: 'No sealed result',
};

/** QA runs are sealed too. This shows the latest seals and lets the browser verify them with the published key. */
function QaEvidenceList() {
  const { api, call } = useApp();
  const [items, setItems] = useState<Array<{ run: QaRunSummary; state: SealCheck['state'] }> | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let stale = false;
    setItems(null);
    setError(null);
    void (async () => {
      try {
        const list = await call(() => api.qaRuns(10));
        const recent = (list.runs || [])
          .filter((run) => ['SUCCESS', 'FAILED', 'CANCELLED'].includes(run.status))
          .slice(0, 5);
        const rows = await Promise.all(recent.map(async (run) => {
          try {
            const detail = await call(() => api.qaRun(run.id));
            const check = await verifyQaSeal(detail.evidence);
            return { run, state: check.state };
          } catch {
            return { run, state: 'missing' as const };
          }
        }));
        if (!stale) setItems(rows);
      } catch (caught) {
        if (!stale) setError(caught);
      }
    })();
    return () => { stale = true; };
  }, [api, call, attempt]);

  if (error) return <RetryBlock error={error} retry={() => setAttempt((value) => value + 1)} />;
  if (!items) return <Loading text="Loading QA seals" />;
  if (items.length === 0) {
    return (
      <div className="lv-empty" id="qa-evidence-empty">
        <p className="lv-muted">No finished QA runs yet. QA results are sealed when a run finishes.</p>
        <a className="lv-btn" href="#qa">Open QA</a>
      </div>
    );
  }
  return (
    <ul className="lv-evidence-list" id="qa-evidence-list">
      {items.map(({ run, state }) => (
        <li className="lv-evidence-item" key={run.id}>
          <a className="lv-evidence-row" href={'#qa/' + encodeURIComponent(run.id)} style={{ textDecoration: 'none' }}>
            <div className="lv-evidence-main">
              <span className="lv-link lv-run-link">QA run · {shortRepo(run.repo || '') || 'repository'}</span>
              <div className="lv-small lv-muted">
                <StatusPill status={run.status} /> {run.sha ? <span className="lv-mono">{run.sha.slice(0, 7)}</span> : null} · {formatDateTime(run.finishedAt || run.createdAt)}
              </div>
            </div>
            <span className={'lv-pill ' + (state === 'verified' ? 'lv-pill-success' : state === 'invalid' ? 'lv-pill-failed' : 'lv-pill-queued')}>{SEAL_LABEL[state]}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

export default function Evidence(_props: { param: string }) {
  return (
    <main className="lv-main" id="live-audit">
      <PageHeader title="Evidence" subtitle="Every finished cloud run has a signed evidence bundle. Verify it here, or on your own machine with the CLI." />
      <Card title="Service signing key"><SigningKey /></Card>
      <Card title="Runs with evidence"><div id="evidence-list"><EvidenceList /></div></Card>
      <Card title="QA run seals">
        <p className="lv-muted lv-small">QA runs have their own signed result. The browser checks each seal with the key the service published with it.</p>
        <QaEvidenceList />
      </Card>
    </main>
  );
}
