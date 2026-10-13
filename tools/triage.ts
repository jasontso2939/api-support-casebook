// Log triage CLI.
//   node tools/triage.ts <northwind.jsonl> [--customer contoso.jsonl] [--limit 100] [--json]
import { readFileSync } from 'node:fs';
import { summarize, detect } from './detectors.ts';
import type { LogEntry } from '../provider/server.ts';

export function readJsonl(path: string) {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

export function report(logs: LogEntry[], customer: any[] = [], limit = 100): string {
  const s = summarize(logs);
  const f = detect(logs, customer, { limit });
  const pad = (v: unknown, n: number, right = false) => right ? String(v).padStart(n) : String(v).padEnd(n);
  const lines = [
    `Northwind triage · ${s.requests} requests, ${s.deliveries} webhook deliveries · ${s.from.replace('T', ' ').slice(0, 19)} to ${s.to.replace('T', ' ').slice(0, 19)} UTC`,
    '',
    `${pad('ENDPOINT', 30)}${pad('REQS', 6, true)}${pad('2xx', 6, true)}${pad('4xx', 6, true)}${pad('5xx', 6, true)}${pad('p50 ms', 8, true)}${pad('p95 ms', 8, true)}`,
    ...s.endpoints.map(e => `${pad(e.endpoint, 30)}${pad(e.n, 6, true)}${pad(e.s2xx, 6, true)}${pad(e.s4xx, 6, true)}${pad(e.s5xx, 6, true)}${pad(e.p50, 8, true)}${pad(e.p95, 8, true)}`),
    '',
    s.errors.length ? 'ERRORS' : 'ERRORS  none',
    ...s.errors.map(e => `  ${pad(e.status, 4)}${pad(e.code, 28)}${pad(e.n, 5, true)}`),
    '',
    f.length ? `FINDINGS (${f.length})` : 'FINDINGS  none: nothing matches a known pattern',
  ];
  for (const x of f) {
    lines.push(`  [${x.severity}] ${x.title}`);
    lines.push(`    ${x.detail}`);
    lines.push(`    first seen ${x.first_seen}`);
    lines.push(`    evidence: ${x.evidence.join(', ')}`);
    lines.push(`    next: ${x.next_step}`);
  }
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--customer' && args[args.indexOf(a) - 1] !== '--limit');
  if (!file) { console.error('usage: node tools/triage.ts <northwind.jsonl> [--customer contoso.jsonl] [--limit 100] [--json]'); process.exit(2); }
  const ci = args.indexOf('--customer'), li = args.indexOf('--limit');
  const logs = readJsonl(file), customer = ci >= 0 ? readJsonl(args[ci + 1]) : [];
  const limit = li >= 0 ? Number(args[li + 1]) : 100;
  if (args.includes('--json')) console.log(JSON.stringify({ summary: summarize(logs), findings: detect(logs, customer, { limit }) }, null, 2));
  else console.log(report(logs, customer, limit));
}
