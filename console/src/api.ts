/**
 * Browser client for the Airlock Cloud API (docs/cloud-api.md).
 * Same-origin: nginx serves the API under /api on the console's own host, so the session cookie is first-party
 * and the strict Content-Security-Policy (connect-src 'self') holds.
 */
import type { ApiKeyInfo, ErrorBody, Me, RunDetail, RunSummary, UsageInfo } from './types';
import type { QaAnalytics, QaRunDetail, QaRunSummary } from './qa';

export class ApiError extends Error {
  status: number;
  code: string;
  retryAfter: number | null;
  quota: ErrorBody['quota'] | null;
  issues: ErrorBody['issues'] | null;

  constructor(status: number, body: Partial<ErrorBody> | null, retryAfterSeconds?: number | null) {
    super((body && body.message) || `Request failed (HTTP ${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.retryAfter = typeof retryAfterSeconds === 'number' && retryAfterSeconds > 0 ? retryAfterSeconds : null;
    this.code = (body && body.code) || 'INTERNAL';
    this.quota = body && body.quota ? body.quota : null;
    this.issues = body && body.issues ? body.issues : null;
  }
}

function apiBase(): string {
  const override = (window as unknown as { AIRLOCK_API_BASE?: string }).AIRLOCK_API_BASE;
  return override || '/api';
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', 'X-Airlock-Csrf': '1' };
  const init: RequestInit = { method, headers, credentials: 'same-origin' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let response: Response;
  try {
    response = await fetch(apiBase() + path, init);
  } catch {
    throw new ApiError(0, { code: 'INTERNAL', message: 'Cannot reach Airlock Cloud. Check your connection and try again.' });
  }
  if (response.status === 204) return null as T;
  let payload: unknown = null;
  const text = await response.text();
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = null; }
  }
  if (!response.ok) {
    const header = Number(response.headers.get('Retry-After'));
    throw new ApiError(response.status, payload as Partial<ErrorBody> | null, Number.isFinite(header) ? header : null);
  }
  return payload as T;
}

function query(params?: Record<string, string | number | undefined | null>): string {
  const entries = Object.entries(params || {}).filter(([, value]) => value !== undefined && value !== null && value !== '');
  if (!entries.length) return '';
  return '?' + entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join('&');
}

export interface RunList { runs: RunSummary[]; nextCursor: string | null }
export interface AnalyticsDay { date: string; runs: number; success: number; failed: number }
export interface Analytics {
  days: AnalyticsDay[];
  totals: { runs: number; passRate: number | null; medianMs: number | null; requestsAllowed: number; requestsBlocked: number };
}

export interface SyncedArtifact {
  id: string;
  kind: string;
  name: string;
  plaintextSize: number;
  storedSize: number;
  sha256: string;
  contentType: string;
  encrypted: boolean;
  createdAt: string;
}

export const api = {
  health: () => request<unknown>('GET', '/health'),
  login: (email: string, password: string) => request<Me>('POST', '/v1/auth/login', { email, password }),
  logout: () => request<null>('POST', '/v1/auth/logout'),
  /** Resolves to { user, workspace }, or null when nobody is signed in. */
  me: async (): Promise<Me | null> => {
    try {
      return await request<Me>('GET', '/v1/auth/me');
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return null;
      throw error;
    }
  },
  workspace: () => request<Me['workspace']>('GET', '/v1/workspace'),
  renameWorkspace: (name: string) => request<Me['workspace']>('PATCH', '/v1/workspace', { name }),
  usage: () => request<UsageInfo>('GET', '/v1/usage'),
  analytics: (days?: number) => request<Analytics>('GET', '/v1/analytics' + query({ days })),
  keys: {
    list: () => request<{ keys: ApiKeyInfo[] }>('GET', '/v1/keys'),
    create: (name: string) => request<{ key: ApiKeyInfo; token: string }>('POST', '/v1/keys', { name }),
    revoke: (id: string) => request<null>('DELETE', '/v1/keys/' + encodeURIComponent(id)),
  },
  runs: {
    list: (params?: { limit?: number; cursor?: string | null; status?: string }) => request<RunList>('GET', '/v1/runs' + query(params)),
    get: (id: string) => request<RunDetail>('GET', '/v1/runs/' + encodeURIComponent(id)),
    create: (body: unknown) => request<RunSummary>('POST', '/v1/runs', body),
    cancel: (id: string) => request<RunSummary>('POST', '/v1/runs/' + encodeURIComponent(id) + '/cancel'),
    evidence: (id: string) => request<unknown>('GET', '/v1/runs/' + encodeURIComponent(id) + '/evidence'),
  },
  /** QA runs (cloud QA pipeline). The body is validated server-side against CreateQaRunBodySchema. */
  qaSubmit: (body: unknown) => request<{ id: string; status: string }>('POST', '/v1/qa-runs', body),
  qaRun: (id: string) => request<QaRunDetail>('GET', '/v1/qa-runs/' + encodeURIComponent(id)),
  qaRuns: (limit?: number) => request<{ runs: QaRunSummary[] }>('GET', '/v1/qa-runs' + query({ limit })),
  qaAnalytics: () => request<QaAnalytics>('GET', '/v1/qa-analytics'),
  syncArtifacts: (limit?: number) => request<{ artifacts: SyncedArtifact[] }>('GET', '/v1/sync/artifacts' + query({ limit })),
  deleteSyncArtifact: (id: string) => request<null>('DELETE', '/v1/sync/artifacts/' + encodeURIComponent(id)),
  downloadSyncArtifact: async (id: string): Promise<Blob> => {
    const response = await fetch(apiBase() + '/v1/sync/artifacts/' + encodeURIComponent(id), { credentials: 'same-origin' });
    if (!response.ok) throw new ApiError(response.status, { code: 'INTERNAL', message: 'Could not download the synced artifact.' });
    return response.blob();
  },
  evidenceKey: () => request<unknown>('GET', '/v1/evidence-key'),
  verifyEvidence: (bundle: unknown) => request<unknown>('POST', '/v1/evidence/verify', bundle),
};

export type Api = typeof api;
