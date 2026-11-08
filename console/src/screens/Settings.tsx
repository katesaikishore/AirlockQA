import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useApp } from '../app-context';
import { formatDateTime, formatNumber } from '../lib';
import { Card, ErrorBox, Loading, PageHeader, RetryBlock } from '../ui';
import type { SyncedArtifact } from '../api';
import type { Me } from '../types';

type Workspace = Me['workspace'];
type Outcome = { kind: 'error'; error: unknown } | { kind: 'ok' } | { kind: 'empty' } | null;

function formatBytes(value: number): string {
  if (value < 1024) return value + ' B';
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
  return (value / (1024 * 1024)).toFixed(1) + ' MB';
}

/** Encrypted artifacts synced from the local CLI. The server never has the key, so downloads are ciphertext. */
function SyncedLocalData() {
  const { api, call, announce } = useApp();
  const [artifacts, setArtifacts] = useState<SyncedArtifact[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    try {
      const result = await call(() => api.syncArtifacts(50));
      setArtifacts(result.artifacts || []);
    } catch (caught) {
      setError(caught);
    }
  };

  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const download = async (artifact: SyncedArtifact) => {
    setBusy(artifact.id);
    try {
      const blob = await api.downloadSyncArtifact(artifact.id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = artifact.id + '.airlock-enc';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      announce('Encrypted artifact downloaded');
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (artifact: SyncedArtifact) => {
    if (!window.confirm(`Delete the synced artifact "${artifact.name}"?`)) return;
    setBusy(artifact.id);
    try {
      await call(() => api.deleteSyncArtifact(artifact.id));
      setArtifacts((current) => (current || []).filter((item) => item.id !== artifact.id));
      announce('Synced artifact deleted');
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(null);
    }
  };

  if (error && artifacts === null) return <RetryBlock error={error} retry={() => { void load(); }} />;
  if (artifacts === null) return <Loading text="Loading synced local data" />;
  if (artifacts.length === 0) {
    return (
      <div className="lv-empty" id="sync-empty">
        <p className="lv-muted">No local artifacts synced yet. Upload traces, checkpoints, healing logs, fixtures or capsules from your machine:</p>
        <div className="lv-code-wrap"><pre className="lv-code"><code>AIRLOCK_SYNC_KEY='a long passphrase' airlock sync</code></pre></div>
        <p className="lv-muted lv-small">The key stays on your machine; the server stores only AES-256-GCM ciphertext.</p>
      </div>
    );
  }
  return (
    <div id="synced-local-data">
      <p className="lv-muted lv-small">The server stores only encrypted bytes. Download an artifact and decrypt it with <code>airlock sync download &lt;id&gt; --out &lt;file&gt;</code>.</p>
      <div className="lv-table-wrap">
        <table className="lv-table lv-table-stack">
          <caption className="sr-only">Synced local artifacts</caption>
          <thead><tr><th scope="col">Kind</th><th scope="col">Name</th><th scope="col">Size</th><th scope="col">Added</th><th scope="col">Actions</th></tr></thead>
          <tbody>
            {artifacts.map((artifact) => (
              <tr key={artifact.id}>
                <td data-label="Kind" className="lv-mono">{artifact.kind}</td>
                <td data-label="Name" className="lv-wrap">{artifact.name}</td>
                <td data-label="Size" className="lv-mono">{formatBytes(artifact.plaintextSize)}</td>
                <td data-label="Added">{formatDateTime(artifact.createdAt)}</td>
                <td data-label="Actions">
                  <div className="lv-actions">
                    <button type="button" className="lv-btn lv-btn-small" disabled={busy === artifact.id} onClick={() => { void download(artifact); }}>Download</button>
                    <button type="button" className="lv-btn lv-btn-small" disabled={busy === artifact.id} onClick={() => { void remove(artifact); }}>Delete</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function Settings(_props: { param: string }) {
  const { me, api, call, announce, signOut, usage, refreshUsage, setWorkspaceName } = useApp();
  const workspace = me?.workspace;
  const user = me?.user;
  const [details, setDetails] = useState<Workspace | undefined>(workspace);
  const [name, setName] = useState(workspace?.name || '');
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const info = await call(() => api.workspace());
        if (!alive || !info) return;
        setDetails(info);
        if (document.activeElement !== inputRef.current) setName(info.name || '');
        if (info.name) setWorkspaceName(info.name);
      } catch {
        // The details already on screen come from api.me(); keep them.
      }
    })();
    void refreshUsage();
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setOutcome(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setOutcome({ kind: 'empty' });
      inputRef.current?.focus();
      return;
    }
    setSaving(true);
    try {
      const updated = await call(() => api.renameWorkspace(trimmed));
      const finalName = (updated && updated.name) || trimmed;
      setWorkspaceName(finalName);
      setDetails((current) => (current ? { ...current, name: finalName } : current));
      setName(finalName);
      setOutcome({ kind: 'ok' });
      announce('Workspace renamed');
    } catch (error) {
      setOutcome({ kind: 'error', error });
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="lv-main" id="live-settings">
      <PageHeader title="Settings" subtitle="Your workspace and account." />
      <Card title="Workspace">
        <div>
          <form className="lv-form lv-form-inline" id="rename-form" noValidate onSubmit={onSubmit}>
            <div className="lv-field">
              <label htmlFor="workspace-name">Workspace name</label>
              <input
                id="workspace-name" ref={inputRef} className="lv-input" type="text" maxLength={80} required autoComplete="off"
                value={name} onChange={(event) => setName(event.target.value)}
              />
            </div>
            <button type="submit" className="lv-btn lv-btn-primary" disabled={saving} aria-busy={saving ? 'true' : undefined}>Save name</button>
          </form>
          <div id="rename-result" aria-live="polite">
            {outcome?.kind === 'error' ? <ErrorBox error={outcome.error} /> : null}
            {outcome?.kind === 'empty' ? <ErrorBox error={{ message: 'Enter a workspace name.' }} /> : null}
            {outcome?.kind === 'ok' ? <div className="lv-alert lv-alert-ok" role="status"><strong>Workspace renamed.</strong></div> : null}
          </div>
          <div id="settings-details">
            <dl className="lv-meta">
              {details?.createdAt ? <div className="lv-meta-item"><dt>Created</dt><dd>{formatDateTime(details.createdAt)}</dd></div> : null}
              <div className="lv-meta-item"><dt>Plan</dt><dd>Free</dd></div>
            </dl>
          </div>
        </div>
      </Card>
      <Card title="Account">
        <dl className="lv-meta">
          <div className="lv-meta-item"><dt>Email</dt><dd id="settings-email" className="lv-wrap">{user?.email || '—'}</dd></div>
          {user?.name ? <div className="lv-meta-item"><dt>Name</dt><dd className="lv-wrap">{user.name}</dd></div> : null}
        </dl>
      </Card>
      <Card title="Synced local data"><SyncedLocalData /></Card>
      <Card title="Plan">
        <div>
          <p><strong>Free</strong></p>
          <div id="settings-limits">
            {usage ? (
              <dl className="lv-meta">
                <div className="lv-meta-item"><dt>Cloud runs per day</dt><dd>{formatNumber(usage.daily.limit)}</dd></div>
                <div className="lv-meta-item"><dt>Concurrent runs</dt><dd>{String(usage.concurrent.limit)}</dd></div>
                <div className="lv-meta-item"><dt>Steps per run</dt><dd>{String(usage.limits.maxSteps)}</dd></div>
                <div className="lv-meta-item"><dt>Run time limit</dt><dd>{usage.limits.runTimeoutSec + ' seconds'}</dd></div>
                <div className="lv-meta-item"><dt>Active API keys</dt><dd>{String(usage.limits.maxActiveKeys)}</dd></div>
              </dl>
            ) : <p className="lv-muted">Limits are unavailable right now.</p>}
          </div>
        </div>
      </Card>
      <div className="lv-actions">
        <button type="button" className="lv-btn" id="settings-signout" onClick={() => { void signOut(); }}>Sign out</button>
      </div>
    </main>
  );
}
