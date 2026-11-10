/**
 * AirlockQA public MCP server (stdio JSON-RPC 2.0).
 *
 * Exposes the proof/attach surface only:
 *   airlock_evidence_verify — verify a signed run-evidence bundle
 *   airlock_flake           — analyze Airlock reporter manifests
 *
 * No shell execution, no cloud credentials, no investigator/private code. Paths must stay inside the
 * current working directory (or an explicit absolute path supplied by the caller) and are read-only.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { AttestationEngine } from '../compliance/attestation.js';
import { analyzeFlakiness, renderFlakeMarkdown } from '../flake/index.js';
import { readRunReports } from '../testing/airlock-report.js';
import type { ComplianceProofBundle } from '../types/index.js';

export const PROTOCOL_VERSION = '2025-06-18';
export const SERVER_NAME = 'airlockqa';
export const SERVER_VERSION = '1.1.0';
const MAX_BUNDLE_BYTES = 25 * 1024 * 1024;

interface ToolDefinition { name: string; description: string; inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] } }

export const TOOLS: ToolDefinition[] = [
  {
    name: 'airlock_evidence_verify',
    description: 'Verify a signed Airlock run-evidence bundle (Merkle root, hash chain, signature). Set AIRLOCK_SIGNING_KEY for HMAC bundles or AIRLOCK_TRUSTED_PUBLIC_KEY to pin Ed25519.',
    inputSchema: { type: 'object', properties: { bundlePath: { type: 'string', description: 'Path to an attestation-*.json bundle.' } }, required: ['bundlePath'] },
  },
  {
    name: 'airlock_flake',
    description: 'Analyze Airlock reporter manifests and return flake counts, causes and Markdown. Use after `airlock attach` and a Playwright run with the Airlock reporter.',
    inputSchema: { type: 'object', properties: { reportsPath: { type: 'string', description: 'Directory or file of Airlock run manifests. Default .airlock/reports.' }, markdown: { type: 'boolean', description: 'Include the Markdown summary.' } } },
  },
];

function textResult(value: unknown) { return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }; }
function toolError(message: string) { return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true }; }

function safePath(input: string): string {
  const resolved = path.resolve(process.cwd(), input);
  const root = process.cwd();
  if (!resolved.startsWith(root + path.sep) && resolved !== root) throw new Error('path must stay inside the working directory');
  return resolved;
}

function callTool(name: string, args: Record<string, unknown>) {
  if (name === 'airlock_evidence_verify') {
    const bundlePath = safePath(String(args.bundlePath || ''));
    if (!fs.existsSync(bundlePath)) throw new Error(`bundle not found: ${bundlePath}`);
    if (fs.statSync(bundlePath).size > MAX_BUNDLE_BYTES) throw new Error('bundle is too large');
    const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8')) as ComplianceProofBundle;
    const trustedPublicKey = process.env.AIRLOCK_TRUSTED_PUBLIC_KEY?.trim() || undefined;
    const key = process.env.AIRLOCK_SIGNING_KEY?.trim() || undefined;
    const result = AttestationEngine.verifyBundle(bundle, { key, trustedPublicKey });
    return textResult({ valid: result.valid, reason: result.reason, runId: bundle.runId, merkleRoot: bundle.merkleRoot, signingAlgorithm: bundle.signingAlgorithm, insecureDevKey: bundle.insecureDevKey === true, warnings: result.warnings });
  }
  if (name === 'airlock_flake') {
    const target = args.reportsPath ? safePath(String(args.reportsPath)) : path.resolve(process.cwd(), '.airlock/reports');
    if (!fs.existsSync(target)) return toolError(`reports not found: ${target}`);
    const reports = readRunReports(target);
    const analysis = analyzeFlakiness(reports);
    return textResult({ reports: analysis.reports, totalTests: analysis.totalTests, flakyTests: analysis.flakyTests, totals: analysis.totals, warnings: analysis.warnings, ...(args.markdown ? { markdown: renderFlakeMarkdown(analysis) } : {}) });
  }
  throw new Error(`unknown tool: ${name}`);
}

function reply(id: unknown, result: unknown) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); }
function errorReply(id: unknown, code: number, message: string) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n'); }

export function handleMessage(message: any): void {
  if (!message || typeof message !== 'object') return errorReply(null, -32600, 'Invalid Request');
  const id = message.id;
  const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
  if (message.method === 'initialize') return hasId ? reply(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: SERVER_VERSION } }) : undefined;
  if (message.method === 'tools/list') return hasId ? reply(id, { tools: TOOLS }) : undefined;
  if (message.method === 'tools/call') {
    if (!hasId) return;
    const name = String(message.params?.name || '');
    try { return reply(id, callTool(name, message.params?.arguments || {})); }
    catch (error) { return errorReply(id, -32603, (error as Error).message); }
  }
  if (message.method === 'ping') return hasId ? reply(id, {}) : undefined;
  if (message.method?.startsWith('notifications/')) return undefined;
  return errorReply(id ?? null, -32601, 'Method not found');
}

export function startMcpServer(): void {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try { handleMessage(JSON.parse(trimmed)); }
    catch (error) { errorReply(null, -32700, `Parse error: ${(error as Error).message}`); }
  });
}

if (import.meta.main) startMcpServer();
