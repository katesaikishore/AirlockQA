import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../app-context';
import { usePolling } from '../hooks';
import { formatNumber, formatPercent, formatRelative, isActive, targetHost } from '../lib';
import type { QaRunSummary } from '../qa';
import type { RunSummary } from '../types';
import { Card, CodeBlock, Kpi, Loading, PageHeader, RetryBlock, StatusPill } from '../ui';
import { UsageCard } from './UsageCard';
import { statusChanged } from './useRunList';

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

function OnboardingCard() {
  return (
    <section className="lv-card lv-onboard" aria-labelledby="ov-empty-title">
      <h2 id="ov-empty-title" className="lv-card-title">No runs yet</h2>
      <p className="lv-sub">Cloud runs open your site in an isolated browser, apply the request policy and return signed evidence. Start one here, or from your terminal:</p>
      <div className="lv-actions"><a className="lv-btn lv-btn-primary" href="#runs/new">Start a cloud run</a></div>
      <div className="lv-stack">
        <CodeBlock text="airlock login" label="Copy" />
        <CodeBlock text="airlock test --cloud" label="Copy" />
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
  const recentRef = useRef<OverviewRow[]>([]);

  const loadRecent = useCallback(async () => {
    // Workflow runs and QA runs are separate lists on the server; Overview shows both, newest first.
    const [workflow, qa] = await Promise.allSettled([call(() => api.runs.list({ limit: 5 })), call(() => api.qaRuns(20))]);
    if (workflow.status === 'rejected') throw workflow.reason;
    const qaList = qa.status === 'fulfilled' ? (qa.value.runs || []) : [];
    setQaRuns(qaList);
    const rows: OverviewRow[] = [
      ...(workflow.value.runs || []).map((r) => ({ id: r.id, suiteName: r.suiteName, targetUrl: r.targetUrl, status: r.status, createdAt: r.createdAt, queuePosition: r.queuePosition, kind: 'run' as const })),
      ...qaList.map((r) => ({ id: r.id, suiteName: 'QA · ' + (r.repo ? r.repo.replace(/^https:\/\/github\.com\//, '') : 'run'), targetUrl: r.repo || '', status: r.status, createdAt: r.createdAt || '', kind: 'qa' as const })),
    ].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 8);
    const previous = recentRef.current;
    const next = rows;
    recentRef.current = next;
    setRecent(next);
    setRecentError(null);
    if (statusChanged(previous as unknown as RunSummary[], next as unknown as RunSummary[])) void refreshUsage();
  }, [api, call, refreshUsage]);

  const reload = useCallback(async () => {
    const [metrics, runs] = await Promise.allSettled([call(() => api.analytics(30)), loadRecent()]);
    setLoadingKpis(false);
    if (metrics.status === 'fulfilled') {
      setAnalytics(toAnalytics(metrics.value));
      setAnalyticsError(null);
    } else {
      setAnalyticsError(metrics.reason);
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
  // QA runs from the last 7 days (UTC), counted next to the cloud runs.
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const qaThisWeek = qaRuns.filter((r) => r.createdAt && Date.parse(r.createdAt) >= weekAgo).length;

  let kpis;
  if (loadingKpis) kpis = <Loading text="Loading metrics" />;
  else if (!analytics) kpis = <RetryBlock error={analyticsError} retry={retry} />;
  else {
    kpis = (
      <>
        <Kpi label="Runs this week" value={formatNumber(runsThisWeek(analytics.days) + qaThisWeek)} foot={qaThisWeek ? `Last 7 days, UTC · ${qaThisWeek} QA` : 'Last 7 days, UTC'} />
        <Kpi label="Pass rate" value={finished ? formatPercent(totals?.passRate) : '—'} foot="Last 30 days" />
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

  return (
    <main className="lv-main" id="live-dashboard">
      <PageHeader
        title="Overview"
        subtitle={(workspace || 'Workspace') + (email ? ' · ' + email : '')}
        actions={<><a className="lv-btn" href="#cicd">Connect CI</a><a className="lv-btn lv-btn-primary" href="#runs/new">Start cloud run</a></>}
      />
      <div className="lv-overview-intro">{empty ? <OnboardingCard /> : null}</div>
      <section className="lv-grid lv-grid-kpi" aria-label="Workspace at a glance">{kpis}</section>
      <div className="lv-two-col">
        <Card title="Recent runs" aside={<a className="lv-link" href="#runs">All runs</a>}>
          <div id="ov-recent">{recentBody}</div>
        </Card>
        <Card title="Usage today" className="lv-card-side"><UsageCard /></Card>
      </div>
    </main>
  );
}
