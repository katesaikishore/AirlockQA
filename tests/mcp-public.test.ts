import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import * as readline from 'node:readline';

test('public MCP server lists its two tools and runs flake on demo reports', async () => {
  const child = spawn('bun', ['src/mcp/server.ts'], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'ignore'] });
  const rl = readline.createInterface({ input: child.stdout });
  const pending = new Map<number, (value: any) => void>();
  let next = 1;
  const call = (method: string, params: unknown) => new Promise<any>((resolve) => {
    const id = next++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  rl.on('line', (line) => { try { const message = JSON.parse(line); if (message.id && pending.has(message.id)) { pending.get(message.id)!(message); pending.delete(message.id); } } catch {} });
  try {
    const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(init.result.serverInfo.name).toBe('airlockqa');
    const list = await call('tools/list', {});
    expect(list.result.tools.map((tool: any) => tool.name)).toEqual(['airlock_evidence_verify', 'airlock_flake']);
    const flake = await call('tools/call', { name: 'airlock_flake', arguments: { reportsPath: 'examples/attach-demo/.airlock/reports' } });
    expect(JSON.parse(flake.result.content[0].text).flakyTests).toBeGreaterThan(0);
  } finally {
    child.kill('SIGTERM');
  }
});
