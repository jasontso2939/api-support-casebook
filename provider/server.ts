// Northwind Coverage API: a fictional insurance-data API, built to be supported.
//
// It behaves the way real APIs in this space do: a consent flow that hands back a
// short-lived, single-use authorization code, a token exchange, policy reads guarded
// by client credentials plus an access token, per-client rate limits with
// Retry-After, signed webhooks, and a structured log line for every request.
import http from 'node:http';
import { createHash, createHmac } from 'node:crypto';
import { makeAccount, rng, id } from './fixtures.ts';
import type { Policy, Account } from './fixtures.ts';

export type Env = 'sandbox' | 'production';

export interface LogEntry {
  ts: string; request_id: string; kind: 'request' | 'webhook_delivery'; env: Env;
  client_id: string | null; method: string; endpoint: string; path: string;
  status: number; error_code?: string; latency_ms: number;
  carrier?: string; account_id?: string; policy_id?: string; code_fp?: string;
  retry_after_s?: number; event_id?: string; attempt?: number; target?: string;
}

export interface ProviderOptions {
  env: Env;
  clockBase?: string;                       // ISO time the provider's clock starts at
  rateLimit?: { perSecond: number; burst: number };
  codeTtlMs?: number;
  seed?: string;
}

export interface Provider {
  url: string; env: Env; logs: LogEntry[];
  credentials: { clientId: string; clientSecret: string };
  advance(ms: number): void;               // move the provider clock forward (tests)
  now(): number;
  stop(): Promise<void>;
}

const CREDS: Record<Env, { clientId: string; clientSecret: string }> = {
  sandbox: { clientId: 'nw_test_contoso', clientSecret: 'sk_test_demo_not_a_secret' },
  production: { clientId: 'nw_live_contoso', clientSecret: 'sk_live_demo_not_a_secret' },
};
export const credentialsFor = (env: Env) => ({ ...CREDS[env] });

/** Python-style JSON (", " and ": " separators), the way Northwind's event service writes bodies. */
export function pyJson(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return '[' + v.map(pyJson).join(', ') + ']';
  if (typeof v === 'object') return '{' + Object.entries(v as Record<string, unknown>).map(([k, x]) => JSON.stringify(k) + ': ' + pyJson(x)).join(', ') + '}';
  return JSON.stringify(v);
}

export function sign(secret: string, t: number, rawBody: string) {
  return createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const fp = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 8);

export async function startProvider(opts: ProviderOptions): Promise<Provider> {
  const env = opts.env;
  const limit = opts.rateLimit ?? { perSecond: 100, burst: 100 };
  const codeTtl = opts.codeTtlMs ?? 10 * 60 * 1000;
  const r = rng(opts.seed ?? `provider:${env}`);
  const start = Date.now();
  const base = opts.clockBase ? Date.parse(opts.clockBase) : start;
  let offset = 0;
  const now = () => base + (Date.now() - start) + offset;

  const logs: LogEntry[] = [];
  const accounts = new Map<string, Account>();
  const policies = new Map<string, Policy>();
  const sessions = new Map<string, { user_ref: string }>();
  const codes = new Map<string, { account_id: string; issued: number; used: boolean }>();
  const tokens = new Map<string, { account_id: string; client_id: string }>();
  const buckets = new Map<string, { tokens: number; at: number }>();
  const hooks: { client_id: string; url: string; secret: string; id: string }[] = [];

  function take(client: string): number {          // 0 = allowed, otherwise seconds to wait
    const t = Date.now();
    const b = buckets.get(client) ?? { tokens: limit.burst, at: t };
    b.tokens = Math.min(limit.burst, b.tokens + ((t - b.at) / 1000) * limit.perSecond);
    b.at = t;
    buckets.set(client, b);
    if (b.tokens >= 1) { b.tokens -= 1; return 0; }
    return Math.max(1, Math.ceil((1 - b.tokens) / limit.perSecond));
  }

  async function deliver(client_id: string, event: Record<string, unknown>) {
    const raw = pyJson(event);
    const results = [];
    for (const h of hooks.filter(x => x.client_id === client_id)) {
      let delivered = false;
      for (let attempt = 1; attempt <= 3 && !delivered; attempt++) {
        const t0 = Date.now();
        const t = Math.floor(now() / 1000);
        let status = 0;
        try {
          const res = await fetch(h.url, {
            method: 'POST', body: raw,
            headers: { 'content-type': 'application/json', 'northwind-event-id': String(event.id), 'northwind-signature': `t=${t},v1=${sign(h.secret, t, raw)}` },
          });
          status = res.status; await res.arrayBuffer();
        } catch { status = 0; }
        delivered = status >= 200 && status < 300;
        logs.push({
          ts: new Date(now()).toISOString(), request_id: id('evt_dlv', r, 8), kind: 'webhook_delivery', env, client_id,
          method: 'POST', endpoint: 'webhook', path: new URL(h.url).pathname, status, latency_ms: Date.now() - t0,
          event_id: String(event.id), attempt, target: new URL(h.url).pathname, policy_id: String((event.data as any)?.policy_id ?? ''),
          ...(delivered ? {} : { error_code: status === 0 ? 'connection_failed' : 'endpoint_rejected' }),
        });
        if (!delivered) await sleep(25 * attempt);
      }
      results.push({ endpoint: h.id, delivered });
    }
    return results;
  }

  const server = http.createServer(async (req, res) => {
    const t0 = Date.now();
    const request_id = 'req_' + fp(`${Math.random()}:${t0}:${logs.length}`) + fp(String(r())).slice(0, 4);
    const url = new URL(req.url ?? '/', 'http://x');
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    let body: any = {};
    try { body = bodyText ? JSON.parse(bodyText) : {}; } catch { body = null; }
    const clientId = (req.headers['x-client-id'] as string) ?? null;
    const entry: Partial<LogEntry> = { client_id: clientId, method: req.method ?? 'GET', path: url.pathname };

    const send = (status: number, payload: unknown, extra: Partial<LogEntry> = {}, headers: Record<string, string> = {}) => {
      const err = status >= 400 ? (payload as any)?.error?.code : undefined;
      logs.push({
        ts: new Date(now()).toISOString(), request_id, kind: 'request', env,
        client_id: clientId, method: entry.method!, path: url.pathname, endpoint: entry.endpoint ?? url.pathname,
        status, latency_ms: Date.now() - t0, ...(pathPolicy ? { policy_id: pathPolicy } : {}), ...(err ? { error_code: err } : {}), ...extra,
      } as LogEntry);
      res.writeHead(status, { 'content-type': 'application/json', 'x-request-id': request_id, ...headers });
      res.end(JSON.stringify(status >= 400 ? { error: { ...(payload as any).error, request_id } } : payload));
    };
    const fail = (status: number, code: string, message: string, extra: Partial<LogEntry> = {}, headers: Record<string, string> = {}) =>
      send(status, { error: { code, message } }, extra, headers);

    const path = url.pathname;
    const pathPolicy = path.match(/^\/v1\/policies\/([^/]+)$/)?.[1];
    entry.endpoint =
      /^\/v1\/policies\/[^/]+$/.test(path) ? 'GET /v1/policies/:id' :
      /^\/v1\/accounts\/[^/]+$/.test(path) ? 'GET /v1/accounts/:id' :
      `${req.method} ${path}`;

    if (body === null) return fail(400, 'invalid_json', 'Request body is not valid JSON.');

    // Client authentication: credentials are issued per environment.
    const creds = CREDS[env];
    if (clientId !== creds.clientId || req.headers['x-client-secret'] !== creds.clientSecret) {
      return fail(401, 'invalid_client', 'Client credentials are not valid.');
    }
    const wait = take(clientId);
    if (wait) return fail(429, 'rate_limited', `Rate limit is ${limit.perSecond} requests per second.`, { retry_after_s: wait }, { 'retry-after': String(wait) });

    await sleep(2 + Math.floor(r() * 8));

    if (req.method === 'POST' && path === '/v1/connect/sessions') {
      const sid = id('cs', r, 12);
      sessions.set(sid, { user_ref: String(body.user_ref ?? sid) });
      return send(201, { session_id: sid, connect_url: `https://connect.northwind.example/s/${sid}` });
    }

    if (req.method === 'POST' && path === '/v1/simulate/consent') {           // test harness only
      const s = sessions.get(body.session_id);
      if (!s) return fail(404, 'session_not_found', 'Unknown connect session.');
      const { account, policies: ps } = makeAccount(s.user_ref, Number(body.policies ?? 1));
      accounts.set(account.id, account);
      for (const p of ps) policies.set(p.id, p);
      const code = 'code_' + id('x', r, 24).slice(2);
      codes.set(code, { account_id: account.id, issued: now(), used: false });
      return send(201, { code });
    }

    if (req.method === 'POST' && path === '/v1/token') {
      const code = String(body.code ?? '');
      const c = codes.get(code);
      const extra = { code_fp: code ? fp(code) : undefined };
      if (!c) return fail(400, 'code_unknown', 'Authorization code is not recognized.', extra);
      if (c.used) return send(400, { error: { code: 'code_reused', message: 'Authorization code has already been used.' } }, { ...extra, account_id: c.account_id });
      if (now() - c.issued > codeTtl) return send(400, { error: { code: 'code_expired', message: 'Authorization code expired. Codes are valid for 10 minutes.' } }, { ...extra, account_id: c.account_id });
      c.used = true;
      const tok = 'at_' + id('x', r, 28).slice(2);
      tokens.set(tok, { account_id: c.account_id, client_id: clientId });
      const acct = accounts.get(c.account_id)!;
      return send(200, { access_token: tok, account_id: acct.id, policy_ids: acct.policy_ids }, { ...extra, account_id: acct.id });
    }

    const tokenFor = () => {
      const t = req.headers['x-access-token'] as string | undefined;
      if (!t) return { error: ['token_missing', 'x-access-token header is required.'] as const };
      const rec = tokens.get(t);
      if (!rec || rec.client_id !== clientId) return { error: ['token_invalid', 'Access token is not valid for this client.'] as const };
      return { rec };
    };

    let m = path.match(/^\/v1\/accounts\/([^/]+)$/);
    if (req.method === 'GET' && m) {
      const tk = tokenFor();
      if ('error' in tk) return fail(401, tk.error![0], tk.error![1]);
      if (tk.rec!.account_id !== m[1]) return fail(403, 'account_forbidden', 'This token cannot read that account.', { account_id: m[1] });
      return send(200, accounts.get(m[1]), { account_id: m[1] });
    }

    m = path.match(/^\/v1\/policies\/([^/]+)$/);
    if (req.method === 'GET' && m) {
      const pid = m[1];
      if (!/^pol_[A-Za-z0-9]{10}$/.test(pid)) return fail(404, 'invalid_id', 'Policy IDs look like pol_ followed by 10 characters.');
      const tk = tokenFor();
      if ('error' in tk) return fail(401, tk.error![0], tk.error![1], { policy_id: pid });
      const p = policies.get(pid);
      if (!p) return fail(404, 'not_found', 'No policy with that ID.', { policy_id: pid });
      if (p.account_id !== tk.rec!.account_id) return fail(403, 'policy_forbidden', 'This token cannot read that policy.', { policy_id: pid });
      return send(200, p, { policy_id: pid, account_id: p.account_id, carrier: p.carrier });
    }

    if (req.method === 'POST' && path === '/v1/webhooks') {
      const h = { client_id: clientId, url: String(body.url), secret: 'whsec_' + id('x', r, 24).slice(2), id: id('we', r, 8) };
      hooks.push(h);
      return send(201, { id: h.id, url: h.url, secret: h.secret });
    }

    if (req.method === 'POST' && path === '/v1/simulate/policy-event') {      // test harness only
      const p = policies.get(String(body.policy_id));
      if (!p) return fail(404, 'not_found', 'No policy with that ID.');
      const event = { id: id('evt', r, 12), type: 'policy.updated', created: Math.floor(now() / 1000), data: { policy_id: p.id, account_id: p.account_id, change: body.change ?? { status: 'cancelled' } } };
      const results = await deliver(clientId, event);
      return send(202, { event_id: event.id, deliveries: results }, { policy_id: p.id });
    }

    return fail(404, 'route_not_found', `No route for ${req.method} ${path}.`);
  });

  await new Promise<void>(ok => server.listen(0, '127.0.0.1', () => ok()));
  const port = (server.address() as any).port;
  return {
    url: `http://127.0.0.1:${port}`, env, logs, credentials: credentialsFor(env), now,
    advance(ms: number) { offset += ms; },
    stop: () => new Promise<void>(ok => { server.closeAllConnections?.(); server.close(() => ok()); }),
  };
}
