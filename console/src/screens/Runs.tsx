import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useApp } from '../app-context';
import { usePolling } from '../hooks';
import { navigate } from '../router';
import { STATUS_LABELS } from '../lib';
import type { RunSummary } from '../types';
import type { QaRunSummary } from '../qa';
import { CodeBlock, Loading, PageHeader, RetryBlock } from '../ui';
import { RunsTable } from './RunsTable';
import { StartRunForm } from './StartRunForm';
import { RUN_STATUSES, useRunList } from './useRunList';

function runMatchesSearch(run: RunSummary, query: string): boolean {
  if (!query) return true;
  const haystack = [run.suiteName, run.targetUrl, run.id, run.workflowName, run.status].join(' ').toLowerCase();
  return haystack.includes(query);
}

export default function Runs({ param }: { param: string }) {
  const { search, setSearch, refreshUsage, api, call } = useApp();
  const list = useRunList();
  const { runs, nextCursor, loaded, error, status } = list;
  const [formOpen, setFormOpen] = useState(false);
  const [qaRuns, setQaRuns] = useState<QaRunSummary[] | null>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const suiteRef = useRef<HTMLInputElement>(null);

  const setForm = (open: boolean) => {
    flushSync(() => setFormOpen(open));
    if (open) suiteRef.current?.focus();
    else {
      toggleRef.current?.focus();
      // Leave #runs/new so a later "Start cloud run" link changes the hash and opens the form again.
      if (param === 'new') navigate('runs');
    }
  };

  // Arriving on #runs/new opens the form and, once it is on screen, focuses its first field.
  const [focusRequest, setFocusRequest] = useState(0);
  useEffect(() => {
    if (param !== 'new') return;
    setFormOpen(true);
    setFocusRequest((count) => count + 1);
  }, [param]);
  useEffect(() => {
    if (focusRequest > 0) suiteRef.current?.focus();
  }, [focusRequest]);

  usePolling(() => list.load({ silent: true }), list.hasActive);

  // QA runs are a separate list on the server. Show that they exist so an empty cloud-run list is not mistaken for
  // an empty workspace.
  useEffect(() => {
    let stale = false;
    call(() => api.qaRuns(5)).then(
      (data) => { if (!stale) setQaRuns(Array.isArray(data.runs) ? data.runs : []); },
      () => { if (!stale) setQaRuns([]); }
    );
    return () => { stale = true; };
  }, [api, call]);

  const query = search.trim().toLowerCase();
  const visible = runs.filter((run) => (status === 'all' || run.status === status) && runMatchesSearch(run, query));
  const loadMore = nextCursor ? <button type="button" className="lv-btn" onClick={() => { void list.load({ more: true }); }}>Load more runs</button> : null;

  let results;
  let count = '';
  if (!loaded && !error) {
    results = <Loading text="Loading runs" />;
  } else if (error && runs.length === 0) {
    results = <RetryBlock error={error} retry={() => { void list.load(); }} />;
  } else {
    count = `${visible.length} loaded ${visible.length === 1 ? 'run' : 'runs'}${nextCursor ? ' (more available)' : ''}`;
    if (visible.length === 0) {
      results = runs.length === 0 && status === 'all' && !query ? (
        <div className="lv-empty" id="run-empty-state">
          <h2 className="lv-card-title">No cloud workflow runs yet</h2>
          <p className="lv-muted">
            Cloud workflow runs are separate from QA runs.
            {qaRuns && qaRuns.length > 0 ? ` This workspace has ${qaRuns.length} recent QA run${qaRuns.length === 1 ? '' : 's'}; they are on the QA screen.` : ' QA runs are on the QA screen.'}
          </p>
          <div className="lv-actions"><a className="lv-btn" href="#qa">Open QA runs</a></div>
          <p className="lv-muted">Start a cloud run with the button above, or from your terminal:</p>
          <CodeBlock text="airlock login" label="Copy" />
          <CodeBlock text="airlock test --cloud" label="Copy" />
        </div>
      ) : (
        <div className="lv-empty" id="run-empty-state">
          <p className="lv-muted">{nextCursor && query ? 'No loaded runs match. Load more runs to search further.' : 'No runs match this filter.'}</p>
        </div>
      );
    } else {
      results = <RunsTable runs={visible} />;
    }
  }

  return (
    <main className="lv-main" id="live-runs">
      <PageHeader
        title="Runs"
        subtitle="Hosted workflow runs on Airlock Cloud. QA runs are a separate list on the QA screen."
        actions={<button type="button" className="lv-btn lv-btn-primary" id="start-run-toggle" ref={toggleRef} aria-expanded={formOpen} aria-controls="start-run-panel" onClick={() => setForm(!formOpen)}>Start cloud run</button>}
      />
      <section className="lv-card" id="start-run-panel" hidden={!formOpen} aria-labelledby="start-run-title">
        <h2 id="start-run-title" className="lv-card-title">Start cloud run</h2>
        <StartRunForm
          suiteRef={suiteRef}
          onClose={() => setForm(false)}
          onCreated={async () => {
            // Keep the pages already loaded when no filter is set; otherwise show the unfiltered list.
            const reload = status === 'all' ? list.load({ silent: true }) : list.setStatus('all');
            await Promise.allSettled([reload, refreshUsage()]);
          }}
        />
      </section>
      <div className="lv-toolbar">
        <input id="run-search-full" className="lv-input" type="search" placeholder="Search suite, URL or run id" aria-label="Search runs" autoComplete="off"
          value={search} onChange={(event) => setSearch(event.target.value)} />
        <select id="run-status-filter-full" className="lv-input" aria-label="Filter by status" value={status} onChange={(event) => { void list.setStatus(event.target.value); }}>
          <option value="all">All statuses</option>
          {RUN_STATUSES.map((value) => <option key={value} value={value}>{STATUS_LABELS[value]}</option>)}
        </select>
        <p id="run-result-count" className="lv-muted lv-small" aria-live="polite">{count}</p>
      </div>
      <div id="run-results">{results}</div>
      <div className="lv-actions">{loaded && !(error && runs.length === 0) ? loadMore : null}</div>
    </main>
  );
}
