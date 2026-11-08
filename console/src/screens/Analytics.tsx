import { useEffect, useState } from 'react';
import { useApp } from '../app-context';
import { formatDuration, formatNumber, formatPercent } from '../lib';
import { Card, Kpi, Loading, PageHeader, RetryBlock } from '../ui';
import { QaAnalyticsPanel } from './QaAnalytics';
import './qa.css';

interface AnalyticsDay { date: string; runs: number; success: number; failed: number }
interface AnalyticsData {
  days?: AnalyticsDay[];
  totals?: { runs?: number; passRate?: number | null; medianMs?: number | null; requestsAllowed?: number; requestsBlocked?: number };
}

const RANGES = [7, 14, 30];
const num = (value: unknown): number => Number(value) || 0;

function RunsChart({ days }: { days: AnalyticsDay[] }) {
  const max = Math.max(1, ...days.map((day) => num(day.runs)));
  const total = days.reduce((sum, day) => sum + num(day.runs), 0);
  const first = days[0] ? days[0].date : '';
  const last = days[days.length - 1] ? days[days.length - 1].date : '';
  return (
    <div>
      <div role="img" aria-label={`Runs per day over the last ${days.length} days, ${total} runs in total. A data table follows.`}>
        <div className="lv-bars">
          {days.map((day) => {
            const runs = num(day.runs);
            const success = num(day.success);
            const failed = num(day.failed);
            return (
              <div key={day.date} className="lv-bar-col" title={`${day.date}: ${runs} runs, ${success} passed, ${failed} failed`}>
                <div className="lv-bar" style={{ height: (runs / max) * 100 + '%' }}>
                  <span className="lv-bar-fail" style={{ height: (runs ? (failed / runs) * 100 : 0) + '%' }} />
                  <span className="lv-bar-ok" style={{ height: (runs ? (success / runs) * 100 : 0) + '%' }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="lv-axis"><span>{first}</span><span>{last}</span></div>
      <div className="lv-legend"><span className="lv-legend-ok">Passed</span><span className="lv-legend-fail">Failed or other</span></div>
      <details className="lv-details">
        <summary>Show data table</summary>
        <div className="lv-table-wrap">
          <table className="lv-table lv-table-compact">
            <caption className="sr-only">Runs per day</caption>
            <thead><tr>{['Day', 'Runs', 'Passed', 'Failed'].map((title) => <th key={title} scope="col">{title}</th>)}</tr></thead>
            <tbody>
              {days.map((day) => (
                <tr key={day.date}>
                  <td>{day.date}</td>
                  <td className="lv-mono">{String(day.runs)}</td>
                  <td className="lv-mono">{String(day.success)}</td>
                  <td className="lv-mono">{String(day.failed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

export default function Analytics(_props: { param: string }) {
  const { api, call } = useApp();
  const [days, setDays] = useState(30);
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{ days: number; data: AnalyticsData } | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let stale = false;
    setLoaded(null);
    setError(null);
    call(() => api.analytics(days)).then(
      (data) => { if (!stale) setLoaded({ days, data: data as unknown as AnalyticsData }); },
      (failure: unknown) => { if (!stale) setError(failure); },
    );
    return () => { stale = true; };
  }, [days, attempt, api, call]);

  const ranges = (
    <div className="lv-seg" role="group" aria-label="Day range">
      {RANGES.map((value) => (
        <button key={value} type="button" className="lv-seg-btn" data-days={value} aria-pressed={value === days} onClick={() => setDays(value)}>{value} days</button>
      ))}
    </div>
  );

  let content;
  if (error) {
    content = <RetryBlock error={error} retry={() => setAttempt((value) => value + 1)} />;
  } else if (!loaded) {
    content = <Loading text="Loading analytics" />;
  } else {
    const totals = loaded.data.totals || {};
    const hasRuns = num(totals.runs) > 0;
    const list = loaded.data.days || [];
    content = (
      <>
        <section className="lv-grid lv-grid-kpi" aria-label={`Totals for the last ${loaded.days} days`}>
          <Kpi label="Runs" value={formatNumber(totals.runs)} foot={`Last ${loaded.days} days`} />
          <Kpi label="Pass rate" value={hasRuns ? formatPercent(totals.passRate) : '—'} foot="Finished runs that passed every step" />
          <Kpi label="Median duration" value={hasRuns ? formatDuration(totals.medianMs) : '—'} foot="Per run" />
          <Kpi label="Requests allowed" value={formatNumber(totals.requestsAllowed)} foot="Through the request policy" />
          <Kpi label="Requests blocked" value={formatNumber(totals.requestsBlocked)} foot="Stopped by the request policy" />
        </section>
        <Card title="Runs per day">
          {list.length ? <RunsChart days={list} /> : <p className="lv-muted">No runs in this period.</p>}
        </Card>
      </>
    );
  }

  return (
    <main className="lv-main" id="live-analytics">
      <PageHeader title="Analytics" subtitle="Hosted workflow runs, plus QA results below. Days are UTC." actions={ranges} />
      <div id="analytics-content">{content}</div>
      <p className="lv-muted lv-small" id="analytics-qa-note">
        QA runs are a separate stream: they are not counted in the workflow totals above. Their suite results, hotspots and
        findings are below.
      </p>
      <QaAnalyticsPanel title="QA analytics" />
    </main>
  );
}
