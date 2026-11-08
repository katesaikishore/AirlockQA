import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../app-context';
import { usePolling } from '../hooks';
import { formatNumber, formatPercent, formatRelative, isActive, targetHost } from '../lib';
import type { QaAnalytics, QaRunSummary } from '../qa';
import type { RunSummary } from '../types';
import { Card, CodeBlock, Kpi, Loading, PageHeader, RetryBlock, StatusPill } from '../ui';
import { UsageCard } from './UsageCard';
import { statusChanged } from './useRunList';
import './qa.css';

/** The part of /v1/analytics the overview reads. */
interface OverviewAnalytics {
  days: Array<{ date?: unknown; runs?: unknown }>;
  totals: { runs?: number; passRate?: number | null; requestsAllowed?: number; requestsBlocked?: number };
}

function toAnalytics(value: unknown): OverviewAnalytics {
  const record = (value && typeof value === 'object' ? value : {}) as { days?: unknown; totals?: unknown };
  return {
    days: Array.isArray(record.days) ? (record.days as OverviewAnalytics['days']) : [],
    totals: record.totals && typeof record.totals === 'object' ? (record.totals as OverviewAnalytics['totals']) : {},
  };
}

function runsThisWeek(days: OverviewAnalytics['days']): number {
  const cutoff = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
  return days.filter((day) => String(day.date) >= cutoff).reduce((sum, day) => sum + (Number(day.runs) || 0), 0);
}

/** A row on Overview: a cloud run (workflow) or a QA run, each linking to its own screen. */
interface OverviewRow { id: string; suiteName: string; targetUrl: string; status: string; createdAt: string; queuePosition?: number | null; kind: 'run' | 'qa' }

function RecentRun({ run }: { run: OverviewRow }) {
  return (
    <li className="lv-recent-item">
      <a className="lv-recent-link" href={run.kind === 'qa' ? '#qa/' + encodeURIComponent(run.id) : '#run-detail/' + encodeURIComponent(run.id)}>
        <span className="lv-recent-main">
          <strong>{run.suiteName}</strong>
          <span className="lv-muted lv-small">{targetHost(run.targetUrl)}</span>
        </span>
        <span className="lv-recent-side">
          <StatusPill status={run.status} />
          <span className="lv-muted lv-small">{run.status === 'QUEUED' && run.queuePosition ? 'Position ' + run.queuePosition : formatRelative(run.createdAt)}</span>
        </span>
      </a>
    </li>
  );
}

const SEVERITY_RANK: Record<string, number> = { S1: 1, S2: 2, S3: 3, S4: 4 };

function severityClass(severity: string | undefined): string {
  const value = String(severity || '').toLowerCase();
  return ['s1', 's2', 's3', 's4'].includes(value) ? 'qa-sev-' + value : 'qa-sev-unknown';
}

function Severity({ value }: { value?: string }) {
  return <span className={'qa-sev ' + severityClass(value)}>{value || '?'}</span>;
}

function qaFailPercent(qa: QaAnalytics | null): string {
  const total = Number(qa?.failRate?.total) || 0;
  if (!total) return '—';
  const failed = Number(qa?.failRate?.failed) || 0;
  return Math.round((failed / total) * 100) + '%';
}

function OnboardingCard() {
  return (
    <section className="lv-card lv-onboard" aria-labelledby="ov-empty-title">
      <h2 id="ov-empty-title" className="lv-card-title">No runs yet</h2>
      <p className="lv-sub">
        Cloud runs open your site in an isolated browser, apply the request policy and return signed evidence. QA runs build
        and test a public repository at a commit, with failure screenshots and a signed result. Start either one here, or from
        your terminal:
      </p>
      <div className="lv-actions">
        <a className="lv-btn lv-btn-primary" href="#runs/new">Start a cloud run</a>
        <a className="lv-btn" href="#qa">Run QA</a>
      </div>
      <div className="lv-stack">
        <CodeBlock text="airlock login" label="Copy" />
        <CodeBlock text="airlock test --cloud" label="Copy" />
        <CodeBlock text="airlock qa --wait" label="Copy" />
      </div>
      <p className="lv-muted lv-small">Create an API key under <a className="lv-link" href="#cicd">CI/CD &amp; API</a> first, then paste it when <code>airlock login</code> asks.</p>
    </section>
  );
}

export default function Overview(_props: { param: string }) {
  const { me, api, call, refreshUsage, reportRuns } = useApp();
  const [analytics, setAnalytics] = useState<OverviewAnalytics | null>(null);
  const [analyticsError, setAnalyticsError] = useState<unknown>(null);
  const [loadingKpis, setLoadingKpis] = useState(true);
  const [recent, setRecent] = useState<OverviewRow[] | null>(null);
  const [recentError, setRecentError] = useState<unknown>(null);
  const [qaRuns, setQaRuns] = useState<QaRunSummary[]>([]);
  const [qa, setQa] = useState<QaAnalytics | null>(null);
  const [qaError, setQaError] = useState<unknown>(null);
  const recentRef = useRef<OverviewRow[]>([]);

  const loadRecent = useCallback(async () => {
    // Workflow runs and QA runs are separate lists on the server; Overview shows both, newest first.
    const [workflow, qaList] = await Promise.allSettled([call(() => api.runs.list({ limit: 5 })), call(() => api.qaRuns(50))]);
    if (workflow.status === 'rejected') throw workflow.reason;
    const qaRunsList = qaList.status === 'fulfilled' ? (qaList.value.runs || []) : [];
    setQaRuns(qaRunsList);
    const rows: OverviewRow[] = [
      ...(workflow.value.runs || []).map((r) => ({ id: r.id, suiteName: r.suiteName, targetUrl: r.targetUrl, status: r.status, createdAt: r.createdAt, queuePosition: r.queuePosition, kind: 'run' as const })),
      ...qaRunsList.map((r) => ({ id: r.id, suiteName: 'QA run', targetUrl: r.repo || '', status: r.status, createdAt: r.createdAt || '', kind: 'qa' as const })),
    ].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 8);
    const previous = recentRef.current;
    const next = rows;
    recentRef.current = next;
    setRecent(next);
    setRecentError(null);
    if (statusChanged(previous as unknown as RunSummary[], next as unknown as RunSummary[])) void refreshUsage();
  }, [api, call, refreshUsage]);

  const reload = useCallback(async () => {
    const [metrics, runs, qaStats] = await Promise.allSettled([
      call(() => api.analytics(30)),
      loadRecent(),
      call(() => api.qaAnalytics()),
    ]);
    setLoadingKpis(false);
    if (metrics.status === 'fulfilled') {
      setAnalytics(toAnalytics(metrics.value));
      setAnalyticsError(null);
    } else {
      setAnalyticsError(metrics.reason);
    }
    if (qaStats.status === 'fulfilled') {
      setQa(qaStats.value);
      setQaError(null);
    } else {
      setQaError(qaStats.reason);
    }
    if (runs.status === 'rejected') setRecentError(runs.reason);
  }, [api, call, loadRecent]);

  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => { if (recent) reportRuns('overview', recent.filter((r) => r.kind === 'run') as unknown as RunSummary[]); }, [recent, reportRuns]);
  useEffect(() => () => reportRuns('overview', []), [reportRuns]);
  usePolling(loadRecent, (recent || []).some((run) => isActive(run.status)));

  const retry = () => {
    setLoadingKpis(analytics === null);
    void reload();
  };

  const email = me?.user.email;
  const workspace = me?.workspace.name;
  const totals = analytics?.totals;
  const finished = Boolean(totals && Number(totals.runs) > 0);
  const empty = recent !== null && recent.length === 0 && !recentError && !(totals && totals.runs);
  const qaFindings = [...(qa?.findings ?? [])].sort((a, b) =>
    (SEVERITY_RANK[a.severity || ''] || 9) - (SEVERITY_RANK[b.severity || ''] || 9) ||
    Number(b.buildsOpen) - Number(a.buildsOpen)
  );
  const qaSerious = qaFindings.filter((finding) => finding.severity === 'S1' || finding.severity === 'S2').length;
  // QA runs from the last 7 days (UTC), counted next to the cloud runs.
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const qaThisWeek = qaRuns.filter((run) => run.createdAt && Date.parse(run.createdAt) >= weekAgo).length;

  let kpis;
  if (loadingKpis) kpis = <Loading text="Loading metrics" />;
  else if (!analytics) kpis = <RetryBlock error={analyticsError} retry={retry} />;
  else {
    kpis = (
      <>
        <Kpi label="Runs this week" value={formatNumber(runsThisWeek(analytics.days) + qaThisWeek)} foot={qaThisWeek ? `Last 7 days, UTC · ${qaThisWeek} QA` : 'Last 7 days, UTC'} />
        <Kpi label="Cloud pass rate" value={finished ? formatPercent(totals?.passRate) : '—'} foot="Hosted workflow runs" />
        <Kpi label="QA fail rate" value={qa ? qaFailPercent(qa) : '—'} foot={qa ? `${Number(qa.failRate?.failed) || 0} of ${Number(qa.failRate?.total) || 0} suite results` : 'No finished QA runs'} />
        <Kpi label="QA findings" value={qa ? formatNumber(qaFindings.length) : '—'} foot={qaFindings.length ? `${qaSerious} S1/S2 · ${Number(qa?.runs) || 0} finished runs` : 'No findings stored'} />
        <Kpi label="Requests allowed" value={formatNumber(totals?.requestsAllowed)} foot="Last 30 days" />
        <Kpi label="Requests blocked" value={formatNumber(totals?.requestsBlocked)} foot="Last 30 days" />
      </>
    );
  }

  let recentBody;
  if (recentError && recent === null) recentBody = <RetryBlock error={recentError} retry={retry} />;
  else if (recent === null) recentBody = <Loading text="Loading runs" />;
  else if (recent.length === 0) recentBody = <p className="lv-muted">Nothing has run yet.</p>;
  else recentBody = <ul className="lv-recent">{recent.map((run) => <RecentRun key={run.id} run={run} />)}</ul>;

  let qaBody;
  if (qaError && qa === null) qaBody = <RetryBlock error={qaError} retry={retry} />;
  else if (qa === null) qaBody = <Loading text="Loading QA analytics" />;
  else if (qaFindings.length === 0) {
    qaBody = <p className="lv-muted">No QA findings stored yet. {Number(qa.runs) || 0} finished QA run{Number(qa.runs) === 1 ? '' : 's'}.</p>;
  } else {
    qaBody = (
      <>
        <div className="lv-table-wrap">
          <table className="lv-table lv-table-compact lv-table-stack" id="ov-qa-findings-table">
            <caption className="sr-only">Open QA findings</caption>
            <thead><tr><th scope="col">Severity</th><th scope="col">Finding</th><th scope="col">Route</th><th scope="col">Runs open</th></tr></thead>
            <tbody>
              {qaFindings.slice(0, 5).map((finding) => (
                <tr key={finding.fingerprint}>
                  <td data-label="Severity"><Severity value={finding.severity} /></td>
                  <td data-label="Finding">{finding.assertion || finding.fingerprint}</td>
                  <td data-label="Route" className="lv-mono">{finding.route || '—'}</td>
                  <td data-label="Runs open" className="lv-mono">{String(finding.buildsOpen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="lv-muted lv-small">
          {qaFindings.length} distinct finding{qaFindings.length === 1 ? '' : 's'} across {Number(qa.runs) || 0} finished QA runs,
          {' '}{qaSerious} S1/S2. <a className="lv-link" href="#qa">Open QA</a> for the runs and full analytics.
        </p>
      </>
    );
  }

  return (
    <main className="lv-main" id="live-dashboard">
      <PageHeader
        title="Overview"
        subtitle={(workspace || 'Workspace') + (email ? ' · ' + email : '')}
        actions={<><a className="lv-btn" href="#cicd">Connect CI</a><a className="lv-btn" href="#qa">Run QA</a><a className="lv-btn lv-btn-primary" href="#runs/new">Start cloud run</a></>}
      />
      <div className="lv-overview-intro">{empty ? <OnboardingCard /> : null}</div>
      <section className="lv-grid lv-grid-kpi" aria-label="Workspace at a glance">{kpis}</section>
      <div className="lv-two-col">
        <Card title="Recent runs" aside={<a className="lv-link" href="#runs">All runs</a>}>
          <div id="ov-recent">{recentBody}</div>
        </Card>
        <Card title="Usage today" className="lv-card-side"><UsageCard /></Card>
      </div>
      <Card title="QA findings" aside={<a className="lv-link" href="#qa">Open QA</a>}>
        <div id="ov-qa-findings">{qaBody}</div>
      </Card>
    </main>
  );
}
