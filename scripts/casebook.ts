// Runs every scenario both ways, then writes each ticket's README, sample logs, and the
// static casebook site in docs/. Every number in the write-ups comes from these runs.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { SCENARIOS } from './scenarios.ts';
import type { RunResult } from './scenarios.ts';
import { summarize, detect } from '../tools/detectors.ts';
import { report } from '../tools/triage.ts';
import { render, diff, esc, inline } from './markdown.ts';
import type { LogEntry } from '../provider/server.ts';

const FIXED: Record<string, [string, string]> = {
  'TCK-1041': ['customer/config.ts', 'loadConfig'],
  'TCK-1042': ['customer/connect.ts', 'completeConnect'],
  'TCK-1043': ['customer/recheck.ts', 'recheckAll'],
  'TCK-1044': ['customer/webhooks.ts', 'handleWebhook'],
  'TCK-1045': ['customer/policies.ts', 'createPolicyService'],
};

function fn(file: string, name: string): string {
  const lines = readFileSync(file, 'utf8').split('\n');
  const start = lines.findIndex(l => new RegExp(`^export (async )?function ${name}\\b`).test(l));
  const end = lines.findIndex((l, i) => i > start && l === '}');
  return lines.slice(start, end + 1).join('\n');
}

const pt = (iso: string) => {
  const d = new Date(Date.parse(iso) - 7 * 3600 * 1000);
  return d.toISOString().slice(11, 23);
};
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? 0; };

function pickRows(ticket: string, r: RunResult): LogEntry[] {
  const L = r.provider;
  switch (ticket) {
    case 'TCK-1041': {
      const firstBad = L.findIndex(l => l.status === 401);
      return [...L.slice(0, firstBad).filter(l => l.status < 300).slice(-3), ...L.slice(firstBad, firstBad + 5)];
    }
    case 'TCK-1042': {
      const dupFp = [...new Set(L.filter(l => l.error_code === 'code_reused').map(l => l.code_fp))].slice(0, 2);
      return L.filter(l => l.code_fp && dupFp.includes(l.code_fp)).concat(L.filter(l => l.endpoint === 'POST /v1/token' && l.status === 200 && !dupFp.includes(l.code_fp)).slice(0, 1))
        .sort((a, b) => a.ts.localeCompare(b.ts));
    }
    case 'TCK-1043': {
      const first429 = L.findIndex(l => l.status === 429);
      const p = L[first429].path;
      const retries = L.filter(l => l.path === p);
      return [...L.slice(first429 - 2, first429 + 3), ...retries.filter(x => !L.slice(first429 - 2, first429 + 3).includes(x)).slice(0, 3)];
    }
    case 'TCK-1044':
      return L.filter(l => l.kind === 'webhook_delivery').slice(0, 6);
    case 'TCK-1045': {
      const bad = r.customer.find(e => e.event === 'rental_check' && e.policy_used !== e.policy_requested);
      return L.filter(l => l.account_id === bad.account_id && l.kind === 'request');
    }
  }
  return [];
}

function logTable(rows: LogEntry[]): string {
  const head = '| Time (PT) | Request ID | Client | Endpoint | Status | Error | ms |\n| --- | --- | --- | --- | --- | --- | --- |';
  const body = rows.map(l => {
    const ep = l.kind === 'webhook_delivery' ? `webhook → ${l.target} (event ${l.event_id}, try ${l.attempt})` : (l.policy_id ? `GET /v1/policies/${l.policy_id}` : l.endpoint) + (l.code_fp ? ` (code ${l.code_fp})` : '');
    return `| ${pt(l.ts)} | \`${l.request_id}\` | \`${l.client_id}\` | ${ep} | ${l.status} | ${l.error_code ?? ''} | ${l.latency_ms} |`;
  });
  return [head, ...body].join('\n');
}

function customerTable(r: RunResult): string {
  const rows = r.customer.filter(e => e.event === 'rental_check');
  return '| Time (PT) | Contoso event | Policy requested | Policy used | Approved | Reasons |\n| --- | --- | --- | --- | --- | --- |\n' +
    rows.map(e => `| ${pt(e.ts)} | ${e.event} | \`${e.policy_requested}\` | \`${e.policy_used}\` | ${e.approved ? 'yes' : '**no**'} | ${e.reasons.join(', ')} |`).join('\n');
}

function extraMetrics(ticket: string, r: RunResult): Record<string, any> {
  const m: Record<string, any> = { ...r.metrics };
  const s = summarize(r.provider);
  m.peak_per_second = s.peak_per_second;
  if (ticket === 'TCK-1041') {
    const f = detect(r.provider).find(x => x.id === 'env_mismatch');
    m.first_seen = f ? `${pt(f.first_seen).slice(0, 5)} PT` : 'n/a';
    m.config_error = r.customer.find(e => e.event === 'deploy')?.error ?? '';
  }
  if (ticket === 'TCK-1042') {
    const groups = new Map<string, LogEntry[]>();
    for (const l of r.provider.filter(l => l.code_fp)) groups.set(l.code_fp!, [...(groups.get(l.code_fp!) ?? []), l]);
    m.median_gap_ms = median([...groups.values()].filter(g => g.length > 1).map(g => Date.parse(g[g.length - 1].ts) - Date.parse(g[0].ts)));
  }
  return m;
}

function parse(tpl: string) {
  const [, fm, body] = tpl.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)!;
  const meta = Object.fromEntries(fm.split('\n').map(l => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]));
  return { meta, body };
}

const CSS = `
:root{--ink:#14202e;--muted:#5b6b7f;--line:#e3e8ef;--bg:#f6f8fb;--card:#fff;--navy:#0f1b2d;--accent:#7c5cff;--sev1:#d64545;--sev2:#d88a14;--sev3:#2f78c4;--ok:#1f9d63}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 Inter,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:#4b3bd1}code{font:0.88em "SF Mono",Menlo,Consolas,monospace;background:#eef1f6;padding:1px 5px;border-radius:5px}
header.top{background:var(--navy);color:#e8edf5;padding:34px 16px 30px}
.wrap{max-width:1040px;margin:0 auto;padding:0 16px}
header.top .wrap{padding:0}
.crumb{font:600 13px/1 "SF Mono",Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;color:#a99bff}
.crumb a{color:#a99bff;text-decoration:none}
h1{font-size:clamp(28px,4.5vw,42px);line-height:1.12;margin:14px 0 10px;letter-spacing:-.01em}
header.top p{color:#b7c2d4;max-width:760px;margin:0}
.pills{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px}
.pill{font:600 13px/1 Inter,sans-serif;padding:7px 11px;border-radius:999px;background:rgba(255,255,255,.08);color:#dfe6f2}
.pill.s1{background:var(--sev1);color:#fff}.pill.s2{background:var(--sev2);color:#fff}.pill.s3{background:var(--sev3);color:#fff}.pill.ok{background:var(--ok);color:#fff}
main{padding:28px 0 60px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px 24px;margin:0 0 18px}
h2{font-size:22px;margin:30px 0 10px;letter-spacing:-.005em}
main h2:first-child{margin-top:0}
blockquote{margin:12px 0;padding:14px 18px;background:#fff;border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:10px}
blockquote p{margin:6px 0}
.tbl{overflow-x:auto;margin:14px 0;border:1px solid var(--line);border-radius:10px;background:#fff}
table{border-collapse:collapse;width:100%;font-size:13.5px}
th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap;vertical-align:top}
th{background:#f1f4f9;font-weight:600;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
tr:last-child td{border-bottom:0}
.term{margin:14px 0;border-radius:12px;overflow:hidden;background:#0d1117;border:1px solid #1f2a3a}
.term-bar{display:flex;align-items:center;gap:6px;padding:9px 12px;border-bottom:1px solid #1f2a3a;color:#8291a8;font:12px "SF Mono",Menlo,monospace}
.term-bar i{width:10px;height:10px;border-radius:50%;background:#ff5f56;display:inline-block}.term-bar i:nth-child(2){background:#ffbd2e}.term-bar i:nth-child(3){background:#27c93f}
.term-bar span{margin-left:8px}
.term pre{margin:0;padding:14px 16px;color:#c9d1d9;font:12.5px/1.55 "SF Mono",Menlo,Consolas,monospace;overflow-x:auto;white-space:pre-wrap}
.term .hi{color:#ff7b72;font-weight:700}.term .med{color:#f2cc60;font-weight:700}.term .hd{color:#79c0ff}.term .nx{color:#7ee787}.term .ev{color:#a5b4c8}
pre.code{margin:14px 0;padding:14px 16px;background:#0d1117;color:#c9d1d9;border-radius:12px;font:12.5px/1.55 "SF Mono",Menlo,Consolas,monospace;overflow-x:auto}
pre.diff .add{color:#7ee787;background:rgba(46,160,67,.15);display:inline-block;width:100%}pre.diff .del{color:#ffa198;background:rgba(248,81,73,.15);display:inline-block;width:100%}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:18px 0 6px}
.stat{background:#fff;border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.stat b{display:block;font-size:28px;line-height:1.1}.stat span{color:var(--muted);font-size:13.5px}
.tickets a.t{display:block;text-decoration:none;color:inherit;background:#fff;border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin:0 0 12px;transition:border-color .15s,transform .15s}
.tickets a.t:hover{border-color:var(--accent);transform:translateY(-1px)}
.t .row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:6px}
.t .id{font:600 13px "SF Mono",Menlo,monospace;color:var(--muted)}
.t h3{margin:2px 0 6px;font-size:19px}.t p{margin:0;color:var(--muted);font-size:14.5px}
.sev{font:700 11.5px/1 Inter,sans-serif;padding:5px 8px;border-radius:6px;color:#fff}.sev.s1{background:var(--sev1)}.sev.s2{background:var(--sev2)}.sev.s3{background:var(--sev3)}
.tag{font:600 12px/1 Inter,sans-serif;padding:5px 8px;border-radius:6px;background:#eef1f6;color:var(--muted)}
ol.steps{counter-reset:s;list-style:none;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}
ol.steps li{background:#fff;border:1px solid var(--line);border-radius:12px;padding:12px 14px;font-size:14.5px}
ol.steps li b{display:block}
footer{border-top:1px solid var(--line);padding:24px 0 40px;color:var(--muted);font-size:14px}
.nav{display:flex;justify-content:space-between;gap:12px;margin-top:30px;flex-wrap:wrap}
.nav a{background:#fff;border:1px solid var(--line);border-radius:10px;padding:10px 14px;text-decoration:none}
@media (max-width:600px){.card{padding:18px 16px}th,td{padding:7px 8px}}
`;

const sevClass = (s: string) => s.endsWith('1') ? 's1' : s.endsWith('2') ? 's2' : 's3';
const page = (title: string, desc: string, head: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}">
<link rel="stylesheet" href="${head}style.css"></head><body>${body}
<footer><div class="wrap">Northwind, Contoso Rentals and everyone in these tickets are fictional. The API, the integration code, the logs and the tests are real and run with <code>npm test</code>. Built by <a href="https://github.com/jasontso2939">Jason Tso</a> with Claude Code.</div></footer>
</body></html>`;

const REPO = 'https://github.com/jasontso2939/api-support-casebook';

async function main() {
  const dirs = readdirSync('tickets').filter(d => d.startsWith('TCK-')).sort();
  const index: any[] = [];
  mkdirSync('docs/tickets', { recursive: true });
  writeFileSync('docs/style.css', CSS.trim() + '\n');
  for (const dir of dirs) {
    const ticket = dir.slice(0, 8);
    process.stdout.write(`${ticket} `);
    const b = await SCENARIOS[ticket]('buggy');
    const f = await SCENARIOS[ticket]('fixed');
    const bm = extraMetrics(ticket, b), fm = extraMetrics(ticket, f);
    mkdirSync(`samples/${ticket}`, { recursive: true });
    writeFileSync(`samples/${ticket}/northwind.jsonl`, b.provider.map(l => JSON.stringify(l)).join('\n') + '\n');
    if (b.customer.length) writeFileSync(`samples/${ticket}/contoso.jsonl`, b.customer.map(l => JSON.stringify(l)).join('\n') + '\n');
    const triage = report(b.provider, ticket === 'TCK-1045' ? b.customer : []);
    const [file, name] = FIXED[ticket];
    const d = diff(fn(`tickets/${dir}/buggy.ts`, name), fn(file, name), `tickets/${dir}/buggy.ts (what shipped)`, `${file} (fixed)`);
    let logs = logTable(pickRows(ticket, b));
    if (ticket === 'TCK-1045') logs += '\n\nContoso\'s app log for the same bookings:\n\n' + customerTable(b);
    const { meta, body } = parse(readFileSync(`tickets/${dir}/ticket.template.md`, 'utf8'));
    const filled = body
      .replace(/\{\{b\.(\w+)\}\}/g, (_, k) => String(bm[k] ?? `?${k}`))
      .replace(/\{\{f\.(\w+)\}\}/g, (_, k) => String(fm[k] ?? `?${k}`));
    const ghMd = filled.replace('{{logs}}', logs).replace('{{triage}}', '```text\n' + triage + '\n```').replace('{{diff}}', '```diff\n' + d + '\n```');
    const header = `# ${meta.id}: ${meta.title}\n\n**${meta.severity}** · ${meta.area} · opened ${meta.opened} · resolved ${meta.resolved} · pattern: ${meta.pattern}\n\n` +
      `Reproduce it: \`npm run repro -- ${ticket} buggy\`, then \`npm run triage -- runs/${ticket}/buggy/northwind.jsonl\`. Regression test: \`test/regressions.test.ts\`.\n\n`;
    writeFileSync(`tickets/${dir}/README.md`, header + ghMd.trim() + '\n');
    const siteMd = filled.replace('{{logs}}', logs).replace('{{triage}}', '```triage\n' + triage + '\n```').replace('{{diff}}', '```diff\n' + d + '\n```');
    index.push({ ...meta, dir });
    const pos = index.length;
    const html = page(`${meta.id}: ${meta.title}`, meta.pattern, '../', `
<header class="top"><div class="wrap"><div class="crumb"><a href="../index.html">API Support Casebook</a> / ${esc(meta.id)}</div>
<h1>${esc(meta.title)}</h1><p>${esc(meta.pattern)}</p>
<div class="pills"><span class="pill ${sevClass(meta.severity)}">${esc(meta.severity)}</span><span class="pill">${esc(meta.area)}</span><span class="pill">Opened ${esc(meta.opened)}</span><span class="pill ok">Resolved ${esc(meta.resolved)}</span></div></div></header>
<main><div class="wrap"><div class="card">${render(siteMd)}
<p style="margin-top:22px;color:var(--muted);font-size:14px">Run it: <code>npm run repro -- ${ticket} buggy</code> · <a href="${REPO}/tree/main/tickets/${dir}">Source and logs on GitHub</a></p></div>
<div class="nav" id="nav-${pos}"></div></div></main>`);
    writeFileSync(`docs/tickets/${ticket}.html`, html);
  }
  // prev/next links
  index.forEach((t, i) => {
    const p = `docs/tickets/${t.id}.html`;
    const prev = index[i - 1], next = index[i + 1];
    const nav = `${prev ? `<a href="${prev.id}.html">← ${esc(prev.id)}: ${esc(prev.title)}</a>` : '<span></span>'}${next ? `<a href="${next.id}.html">${esc(next.id)}: ${esc(next.title)} →</a>` : '<a href="../index.html">All tickets</a>'}`;
    writeFileSync(p, readFileSync(p, 'utf8').replace(`<div class="nav" id="nav-${i + 1}"></div>`, `<div class="nav">${nav}</div>`));
  });
  const playbook = readFileSync('PLAYBOOK.md', 'utf8');
  writeFileSync('docs/playbook.html', page('Support playbook · API Support Casebook', 'How each ticket is worked, and what each error code usually means.', '', `
<header class="top"><div class="wrap"><div class="crumb"><a href="index.html">API Support Casebook</a> / Playbook</div><h1>Support playbook</h1><p>How every ticket here is worked, and what each Northwind error usually means.</p></div></header>
<main><div class="wrap"><div class="card">${render(playbook.replace(/^# .*\n/, ''))}</div></div></main>`));
  const list = index.map(t => `<a class="t" href="tickets/${t.id}.html"><div class="row"><span class="id">${esc(t.id)}</span><span class="sev ${sevClass(t.severity)}">${esc(t.severity)}</span><span class="tag">${esc(t.area)}</span></div><h3>${esc(t.title)}</h3><p>${esc(t.pattern)}</p></a>`).join('\n');
  const tests = readdirSync('test').reduce((n, fn) => n + (readFileSync(`test/${fn}`, 'utf8').match(/^test\(/gm) ?? []).length, 0);
  writeFileSync('docs/index.html', page('API Support Casebook', 'Five API support tickets worked end to end: logs, triage, root cause, fix, regression test, customer reply.', '', `
<header class="top"><div class="wrap"><div class="crumb">Jason Tso · portfolio project</div>
<h1>API Support Casebook</h1>
<p>Five support tickets against an insurance-data API, each worked end to end: read the logs, find the root cause, unblock the customer, ship a fix with a regression test, and write the reply. The API, the customer's integration and the logs are real code you can run.</p>
<div class="pills"><a class="pill" style="text-decoration:none" href="${REPO}">Code on GitHub</a><a class="pill" style="text-decoration:none" href="playbook.html">Support playbook</a></div></div></header>
<main><div class="wrap">
<div class="grid"><div class="stat"><b>5</b><span>tickets, Sev 1 to Sev 3</span></div><div class="stat"><b>${tests}</b><span>automated tests</span></div><div class="stat"><b>5</b><span>log patterns the triage tool detects</span></div><div class="stat"><b>0</b><span>runtime dependencies</span></div></div>
<h2>Why this exists</h2>
<div class="card"><p>After a final-round interview for a customer success engineering role, the feedback was specific: I needed more hands-on API support experience. So I built the practice ground myself. Northwind is a mock insurance-data API with the behavior real tickets depend on: single-use authorization codes, environment-scoped keys, rate limits with <code>Retry-After</code>, signed webhooks, and a request ID on every log line. Contoso Rentals is a customer whose integration has five realistic bugs.</p></div>
<h2>The tickets</h2>
<div class="tickets">${list}</div>
<h2>How each ticket is worked</h2>
<ol class="steps"><li><b>Acknowledge</b>Reply fast, say what happens next.</li><li><b>Size it</b>Severity from impact, not volume.</li><li><b>Scope it</b>One customer or everyone? Since when?</li><li><b>Read the logs</b>Request IDs, client, endpoint, status, timing.</li><li><b>Unblock</b>Get the customer working before the root cause.</li><li><b>Fix and prove it</b>A change plus a test that fails on the old code.</li><li><b>Close twice</b>A clear reply, and a note that prevents the next one.</li></ol>
<h2>Run it yourself</h2>
<pre class="code">git clone ${REPO}
cd api-support-casebook
npm test                                   # Node 22.18+, no installs
npm run repro -- TCK-1044 buggy            # reproduce a ticket
npm run triage -- runs/TCK-1044/buggy/northwind.jsonl</pre>
</div></main>`));
  console.log('\nwrote docs/, tickets/*/README.md, samples/');
}

await main();
