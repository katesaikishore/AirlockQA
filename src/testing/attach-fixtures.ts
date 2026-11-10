/**
 * Determinism fixtures for the attach path (P0+).
 *
 * The generated `.airlock/airlock-test.ts` shim re-exports Playwright's `test` extended with these
 * auto-use fixtures. A tsconfig path alias maps `@playwright/test` to the shim for the wrapper's test
 * run, so the user's existing specs do not import or change anything: they keep `import { test } from
 * '@playwright/test'`, and this fixture still runs.
 *
 * Two determinism layers are recorded/toggled through environment variables:
 *   AIRLOCK_ATTACH_NETWORK = off (default) | record | replay
 *   AIRLOCK_ATTACH_CLOCK   = fixed (default when the shim is attached) | off
 *   AIRLOCK_ATTACH_TIME    = ISO instant for the fixed clock (default 2026-01-01T00:00:00.000Z)
 *   AIRLOCK_ATTACH_DIR     = directory for fixtures/ledgers (default .airlock)
 *
 * Network record/replay works at the browser-context route layer: every http(s) request/response for
 * a test is stored under `.airlock/network/<test-hash>.json` on a record run, and replayed byte-for-
 * byte on later runs. The clock layer uses Playwright's page.clock API. A request ledger is attached
 * to each test (`airlock-request-ledger`) for triage and CI artifacts.
 *
 * Limits: WebSockets and service workers are not recorded; redirects are captured as final
 * responses; cross-test ordering is not global. This is deterministic for the suite as long as the
 * fixture files are committed or cached.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const DEFAULT_ATTACH_TIME = '2026-01-01T00:00:00.000Z';

export interface AirlockDeterminismSettings {
  network: 'off' | 'record' | 'replay';
  clock: 'fixed' | 'off';
  time: string;
  dir: string;
}

export function readDeterminismSettings(env: Record<string, string | undefined> = process.env): AirlockDeterminismSettings {
  const network = env.AIRLOCK_ATTACH_NETWORK;
  const clock = env.AIRLOCK_ATTACH_CLOCK;
  return {
    network: network === 'record' || network === 'replay' ? network : 'off',
    clock: clock === 'off' ? 'off' : 'fixed',
    time: env.AIRLOCK_ATTACH_TIME && !Number.isNaN(Date.parse(env.AIRLOCK_ATTACH_TIME)) ? env.AIRLOCK_ATTACH_TIME : DEFAULT_ATTACH_TIME,
    dir: env.AIRLOCK_ATTACH_DIR && env.AIRLOCK_ATTACH_DIR.trim() !== '' ? env.AIRLOCK_ATTACH_DIR.trim() : '.airlock',
  };
}

interface RecordedRequest {
  status?: number;
  headers?: Record<string, string>;
  bodyBase64?: string;
  error?: string;
}

interface FixtureFile {
  version: 1;
  testId: string;
  title: string;
  requests: Record<string, RecordedRequest[]>;
}

export interface RequestLedger {
  testId: string;
  title: string;
  file?: string;
  titlePath?: string[];
  mode: AirlockDeterminismSettings['network'];
  requests: number;
  failures: { url: string; status?: number; error?: string }[];
  missing: number;
  fixtureFile?: string;
}

type AnyResponse = { status(): number; headers(): Record<string, string>; body(): Promise<Buffer> };
type AnyRoute = {
  request(): { method(): string; url(): string };
  fetch(): Promise<AnyResponse>;
  fulfill(options: { status?: number; headers?: Record<string, string>; body?: Buffer; response?: AnyResponse }): Promise<void>;
  abort(errorCode?: string): Promise<void>;
  continue(): Promise<void>;
};
type AnyContext = { route(pattern: string, handler: (route: AnyRoute) => Promise<void>): Promise<void> };
type AnyPage = { clock: { install(options: { time: Date }): Promise<void>; setFixedTime(time: Date | string | number): Promise<void> } };
type FixtureInfo = {
  title: string;
  titlePath: string[];
  file?: string;
  attach(name: string, options: { body: string; contentType: string }): Promise<void>;
};
type FixtureFn = (args: { context: AnyContext; page: AnyPage }, use: () => Promise<void>, info: FixtureInfo) => Promise<void>;

function testKey(info: FixtureInfo): string {
  const source = `${info.file || ''}::${info.titlePath.join(' › ')}`;
  return createHash('sha256').update(source).digest('hex').slice(0, 24);
}

function fixturePath(settings: AirlockDeterminismSettings, key: string): string {
  return path.join(settings.dir, 'network', `${key}.json`);
}

function readFixture(file: string): FixtureFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const value = parsed as FixtureFile;
    if (value.version !== 1 || typeof value.requests !== 'object' || value.requests === null) return null;
    return value;
  } catch {
    return null;
  }
}

function cleanHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === 'content-encoding' || lower === 'content-length' || lower === 'transfer-encoding' || lower === 'connection') continue;
    result[name] = value;
  }
  return result;
}

const determinismFixture: FixtureFn = async ({ context, page }, use, info) => {
  const settings = readDeterminismSettings();
  const ledger: RequestLedger = {
    testId: testKey(info),
    title: info.titlePath.join(' › '),
    file: info.file,
    titlePath: info.titlePath,
    mode: settings.network,
    requests: 0,
    failures: [],
    missing: 0,
  };

  if (settings.clock === 'fixed') {
    const time = new Date(settings.time);
    await page.clock.install({ time });
    await page.clock.setFixedTime(time);
  }

  if (settings.network !== 'off') {
    const file = fixturePath(settings, ledger.testId);
    ledger.fixtureFile = file;
    const recorded = settings.network === 'record' ? {} : readFixture(file)?.requests;
    if (settings.network === 'replay' && !recorded) {
      throw new Error(
        `Airlock replay fixture missing for "${ledger.title}" (${file}). ` +
          'Record it first with AIRLOCK_ATTACH_NETWORK=record, then commit/cache .airlock/network.',
      );
    }
    const queues = new Map<string, RecordedRequest[]>(
      Object.entries(recorded || {}).map(([key, list]) => [key, Array.isArray(list) ? [...list] : []]),
    );
    const fresh: Record<string, RecordedRequest[]> = {};

    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = request.url();
      if (!/^https?:/i.test(url)) {
        await route.continue();
        return;
      }
      const key = `${request.method()} ${url}`;
      ledger.requests += 1;

      if (settings.network === 'record') {
        const list = fresh[key] || (fresh[key] = []);
        try {
          const response = await route.fetch();
          const body = await response.body();
          const headers = cleanHeaders(response.headers());
          list.push({ status: response.status(), headers, bodyBase64: body.toString('base64') });
          if (response.status() >= 400) ledger.failures.push({ url, status: response.status() });
          await route.fulfill({ status: response.status(), headers, body });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          list.push({ error: message });
          ledger.failures.push({ url, error: message });
          await route.abort('failed');
        }
        return;
      }

      const queue = queues.get(key);
      const next = queue && queue.shift();
      if (!next) {
        ledger.missing += 1;
        ledger.failures.push({ url, error: 'no recorded response for request' });
        await route.abort('failed');
        return;
      }
      if (next.error) {
        ledger.failures.push({ url, error: next.error });
        await route.abort('failed');
        return;
      }
      if (next.status !== undefined && next.status >= 400) ledger.failures.push({ url, status: next.status });
      await route.fulfill({
        status: next.status ?? 200,
        headers: next.headers ?? {},
        body: Buffer.from(next.bodyBase64 ?? '', 'base64'),
      });
    });

    try {
      await use();
    } finally {
      if (settings.network === 'record') {
        // The test body can finish while late browser requests (favicons, analytics, GitHub fetch) are
        // still in flight. Give the route recorder a short settle window so the fixture captures them;
        // otherwise replay logs missing requests for assets the page asked for after the assertion.
        await new Promise((resolve) => setTimeout(resolve, 750));
        const fileOut: FixtureFile = { version: 1, testId: ledger.testId, title: ledger.title, requests: fresh };
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(fileOut));
      }
      writeLedger(settings, ledger);
      try {
        await info.attach('airlock-request-ledger', {
          body: JSON.stringify(ledger),
          contentType: 'application/json',
        });
      } catch {
        // Attachment capture is best effort; the run result must never fail because of it.
      }
    }
  } else {
    try {
      await use();
    } finally {
      writeLedger(settings, ledger);
    }
  }
};

/** Write the per-test request ledger next to the manifests for `airlock flake` evidence. */
function writeLedger(settings: AirlockDeterminismSettings, ledger: RequestLedger): void {
  try {
    const dir = path.join(settings.dir, 'ledgers');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${ledger.testId}.json`), JSON.stringify(ledger, null, 2));
  } catch {
    // A read-only checkout must not fail the test run because the ledger could not be written.
  }
}

/**
 * Fixture map for Playwright's `test.extend`. The generated attach shim casts this to the app's
 * fixture type because the app owns the concrete Playwright version.
 */
export const airlockDeterminismFixtures = {
  airlockDeterminism: [determinismFixture, { auto: true }],
} as unknown as Record<string, [FixtureFn, { auto: boolean }]>;
