import { afterAll, describe, expect, test } from 'bun:test';
import { runCli } from './cli-helpers.js';

const KEY = 'air_live_' + 'C'.repeat(43);
const servers: Array<{ stop: () => void }> = [];
afterAll(() => { for (const server of servers) server.stop(); });

function stub() {
  let polls = 0;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      const url = new URL(request.url);
      if (request.headers.get('authorization') !== `Bearer ${KEY}`) return Response.json({ message: 'Invalid API key' }, { status: 401 });
      if (request.method === 'POST' && url.pathname === '/v1/applications') {
        return Response.json({ application: { id: 'app_cli1', targetUrl: 'https://example.com', pipelineStatus: 'DISCOVERY_QUEUED' } }, { status: 201 });
      }
      if (request.method === 'GET' && url.pathname === '/v1/applications/app_cli1') {
        polls += 1;
        return Response.json({ application: { id: 'app_cli1', pipelineStatus: polls > 1 ? 'COMPLETE' : 'TESTS_RUNNING' } });
      }
      return Response.json({ message: 'not found' }, { status: 404 });
    },
  });
  servers.push(server);
  return server;
}

describe('qafind app CLI', () => {
  test('starts the one-URL pipeline and can watch it to completion', async () => {
    const server = stub();
    const result = await runCli(['app', 'https://example.com', '--api-url', `http://127.0.0.1:${server.port}`, '--key', KEY, '--watch', '--json'], { env: { QAFIND_API_KEY: KEY } });
    expect(result.code).toBe(0);
    expect(result.output).toContain('app_cli1');
    expect(result.output).toContain('COMPLETE');
  }, 20_000);
});
