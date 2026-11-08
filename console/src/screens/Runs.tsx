import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useApp } from '../app-context';
import { usePolling } from '../hooks';
import { navigate } from '../router';
import { STATUS_LABELS, formatRelative, isActive } from '../lib';
import type { RunSummary } from '../types';
import { shortRepo, type QaRunSummary } from '../qa';
import { CodeBlock, Loading, PageHeader, RetryBlock, StatusPill } from '../ui';
import { RunsTable } from './RunsTable';
import { StartRunForm } from './StartRunForm';
import { RUN_STATUSES, useRunList } from './useRunList';

type RunTab = 'cloud' | 'qa';

function runMatchesSearch(run: RunSummary, query: string): boolean {
  if (!query) return true;
  const haystack = [run.suiteName, run.targetUrl, run.id, run.workflowName, run.status].join(' ').toLowerCase();
  return haystack.includes(query);
}

function qaMatchesSearch(run: QaRunSummary, query: string): boolean {
  if (!query) return true;
  return [run.id, run.repo, run.sha, run.branch, run.status, run.phase].join(' ').toLowerCase().includes(query);
}

function qaSuites(run: QaRunSummary): string {
  return run.suites?.map((entry) => entry.suite).join(', ') || '—';
}

function QaRunsTable({ runs }: { runs: QaRunSummary[] }) {
  return (
    <div className="lv-table-wrap">
      <table className="lv-table lv-table-stack" id="qa-run-table-runs">
        <caption className="sr-only">QA runs</caption>
        <thead>
          <tr>
            <th scope="col">Run</th>
            <th scope="col">Repository</th>
            <th scope="col">Status</th>
            <th scope="col">Phase</th>
            <th scope="col">Suites</th>
            <th scope="col">Started</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id}>
              <td data-label="Run"><a className="lv-link lv-mono" href={'#qa/' + encodeURIComponent(run.id)}>{run.id}</a></td>
              <td data-label="Repository">{shortRepo(run.repo || '') || '—'}</td>
              <td data-label="Status"><StatusPill status={run.status} /></td>
              <td data-label="Phase" className="lv-mono">{run.phase || '—'}</td>
              <td data-label="Suites">{qaSuites(run)}</td>
              <td data-label="Started">{formatRelative(run.finishedAt || run.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Runs({ param }: { param: string }) {
  const { search, setSearch, refreshUsage, api, call } = useApp();
  const list = useRunList();
  const { runs, nextCursor, loaded, error, status } = list;
  const [tab, setTab] = useState<RunTab>('cloud');
  const [formOpen, setFormOpen] = useState(false);
  const [qaRuns, setQaRuns] = useState<QaRunSummary[] | null>(null);
  const [qaError, setQaError] = useState<unknown>(null);
  const [qaStatus, setQaStatus] = useState('all');
  const toggleRef = useRef<HTMLButtonElement>(null);
  const suiteRef = useRef<HTMLInputElement>(null);

  const loadQa = useCallback(async () => {
    try {
      const data = await call(() => api.qaRuns(50));
      setQaRuns(Array.isArray(data.runs) ? data.runs : []);
      setQaError(null);
    } catch (failure) {
      setQaError(failure);
    }
  }, [api, call]);

  useEffect(() => { void loadQa(); }, [loadQa]);
  usePolling(loadQa, Boolean(qaRuns && qaRuns.some((run) => isActive(run.status))));

  const setForm = (open: boolean) => {
    flushSync(() => setFormOpen(open));
    if (open) suiteRef.current?.focus();
    else {
      toggleRef.current?.focus();
      // Leave #runs/new so a later "Start cloud run" link changes the hash and opens the form again.
      if (param === 'new') navigate('runs');
    }
  };

  // Arriving on #runs/new opens the cloud form and, once it is on screen, focuses its first field.
  const [focusRequest, setFocusRequest] = useState(0);
  useEffect(() => {
    if (param !== 'new') return;
    setTab('cloud');
    setFormOpen(true);
    setFocusRequest((count) => count + 1);
  }, [param]);
  useEffect(() => {
    if (focusRequest > 0) suiteRef.current?.focus();
  }, [focusRequest]);

  usePolling(() => list.load({ silent: true }), list.hasActive);

  const query = search.trim().toLowerCase();
  const visible = runs.filter((run) => (status === 'all' || run.status === status) && runMatchesSearch(run, query));
  const qaFiltered = (qaRuns || []).filter((run) => (qaStatus === 'all' || run.status === qaStatus) && qaMatchesSearch(run, query));
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
            {qaRuns && qaRuns.length > 0 ? ` This workspace has ${qaRuns.length} recent QA run${qaRuns.length === 1 ? '' : 's'}; they are on the QA tab.` : ' QA runs are on the QA tab.'}
          </p>
          {qaRuns && qaRuns.length > 0 ? (
            <ul className="lv-recent" id="run-qa-preview">
              {qaRuns.slice(0, 3).map((run) => (
                <li className="lv-recent-item" key={run.id}>
                  <a className="lv-recent-link" href={'#qa/' + encodeURIComponent(run.id)}>
                    <span className="lv-recent-main">
                      <strong>QA run</strong>
                      <span className="lv-muted lv-small">{shortRepo(run.repo || '')}</span>
                    </span>
                    <span className="lv-recent-side">
                      <StatusPill status={run.status} />
                      <span className="lv-muted lv-small">{formatRelative(run.finishedAt || run.createdAt)}</span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="lv-actions">
            <button type="button" className="lv-btn" onClick={() => setTab('qa')}>Open QA runs</button>
            <a className="lv-btn" href="#qa">QA screen</a>
          </div>
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

  let qaResults;
  let qaCount = '';
  if (qaError && qaRuns === null) {
    qaResults = <RetryBlock error={qaError} retry={() => { void loadQa(); }} />;
  } else if (qaRuns === null) {
    qaResults = <Loading text="Loading QA runs" />;
  } else {
    qaCount = `${qaFiltered.length} loaded ${qaFiltered.length === 1 ? 'QA run' : 'QA runs'}${qaRuns.length === 50 ? ' (latest 50)' : ''}`;
    qaResults = qaFiltered.length === 0 ? (
      <div className="lv-empty" id="qa-run-empty-runs">
        <p className="lv-muted">No QA runs match this filter.</p>
        <a className="lv-btn" href="#qa">Open the QA screen</a>
      </div>
    ) : <QaRunsTable runs={qaFiltered} />;
  }

  return (
    <main className="lv-main" id="live-runs">
      <PageHeader
        title="Runs"
        subtitle={tab === 'cloud'
          ? 'Hosted workflow runs on Airlock Cloud. QA runs are on the QA tab.'
          : 'QA runs: a public repository at a commit, built and tested in the cloud sandbox.'}
        actions={tab === 'cloud'
          ? <button type="button" className="lv-btn lv-btn-primary" id="start-run-toggle" ref={toggleRef} aria-expanded={formOpen} aria-controls="start-run-panel" onClick={() => setForm(!formOpen)}>Start cloud run</button>
          : <a className="lv-btn lv-btn-primary" href="#qa">Start QA run</a>}
      />
      <div className="lv-seg" role="group" aria-label="Run type">
        <button type="button" className="lv-seg-btn" data-run-tab="cloud" aria-pressed={tab === 'cloud'} onClick={() => setTab('cloud')}>Cloud workflow runs</button>
        <button type="button" className="lv-seg-btn" data-run-tab="qa" aria-pressed={tab === 'qa'} onClick={() => setTab('qa')}>QA runs</button>
      </div>

      {tab === 'cloud' ? (
        <>
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
        </>
      ) : (
        <>
          <div className="lv-toolbar">
            <input id="qa-run-search-runs" className="lv-input" type="search" placeholder="Search repository, commit or run id" aria-label="Search QA runs" autoComplete="off"
              value={search} onChange={(event) => setSearch(event.target.value)} />
            <select id="qa-run-status-filter-runs" className="lv-input" aria-label="Filter QA runs by status" value={qaStatus} onChange={(event) => setQaStatus(event.target.value)}>
              <option value="all">All statuses</option>
              {RUN_STATUSES.map((value) => <option key={value} value={value}>{STATUS_LABELS[value]}</option>)}
            </select>
            <p id="qa-run-result-count-runs" className="lv-muted lv-small" aria-live="polite">{qaCount}</p>
          </div>
          <div id="qa-run-results-runs">{qaResults}</div>
        </>
      )}
    </main>
  );
}
