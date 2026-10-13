// Turns request logs into findings: the patterns behind recurring tickets, written
// down once so they can be checked automatically the next time.
import type { LogEntry } from '../provider/server.ts';

export interface Finding {
  id: string; severity: 'high' | 'medium' | 'low'; title: string; detail: string;
  count: number; first_seen: string; evidence: string[]; next_step: string;
}
export interface EndpointRow { endpoint: string; n: number; s2xx: number; s4xx: number; s5xx: number; p50: number; p95: number }
export interface Summary {
  requests: number; deliveries: number; from: string; to: string;
  endpoints: EndpointRow[]; errors: { status: number; code: string; n: number }[];
  peak_per_second: number; carriers: { carrier: string; n: number; p95: number }[];
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const keyEnv = (clientId: string | null) => clientId?.startsWith('nw_live_') ? 'production' : clientId?.startsWith('nw_test_') ? 'sandbox' : 'unknown';
const t = (e: { ts: string }) => Date.parse(e.ts);

export function summarize(logs: LogEntry[]): Summary {
  const reqs = logs.filter(l => l.kind === 'request');
  const by = new Map<string, LogEntry[]>();
  for (const l of reqs) by.set(l.endpoint, [...(by.get(l.endpoint) ?? []), l]);
  const endpoints = [...by.entries()].map(([endpoint, xs]) => ({
    endpoint, n: xs.length,
    s2xx: xs.filter(x => x.status < 300).length, s4xx: xs.filter(x => x.status >= 400 && x.status < 500).length, s5xx: xs.filter(x => x.status >= 500).length,
    p50: pct(xs.map(x => x.latency_ms), 50), p95: pct(xs.map(x => x.latency_ms), 95),
  })).sort((a, b) => b.n - a.n);
  const errs = new Map<string, { status: number; code: string; n: number }>();
  for (const l of logs.filter(l => l.status >= 400 || l.status === 0)) {
    const k = `${l.kind === 'webhook_delivery' ? 'webhook ' : ''}${l.status} ${l.error_code ?? ''}`;
    const e = errs.get(k) ?? { status: l.status, code: (l.kind === 'webhook_delivery' ? 'webhook: ' : '') + (l.error_code ?? ''), n: 0 };
    e.n++; errs.set(k, e);
  }
  const sec = new Map<number, number>();
  for (const l of reqs) { const s = Math.floor(t(l) / 1000); sec.set(s, (sec.get(s) ?? 0) + 1); }
  const car = new Map<string, number[]>();
  for (const l of reqs.filter(l => l.carrier)) car.set(l.carrier!, [...(car.get(l.carrier!) ?? []), l.latency_ms]);
  return {
    requests: reqs.length, deliveries: logs.length - reqs.length,
    from: logs[0]?.ts ?? '', to: logs[logs.length - 1]?.ts ?? '',
    endpoints, errors: [...errs.values()].sort((a, b) => b.n - a.n),
    peak_per_second: Math.max(0, ...sec.values()),
    carriers: [...car.entries()].map(([carrier, xs]) => ({ carrier, n: xs.length, p95: pct(xs, 95) })),
  };
}

/** Test credentials calling production (or the reverse). */
export function envMismatch(logs: LogEntry[]): Finding[] {
  const bad = logs.filter(l => l.status === 401 && l.error_code === 'invalid_client' && keyEnv(l.client_id) !== 'unknown' && keyEnv(l.client_id) !== l.env);
  if (!bad.length) return [];
  const lastGood = [...logs].reverse().find(l => l.status < 300 && t(l) < t(bad[0]));
  const share = bad.length / logs.filter(l => t(l) >= t(bad[0]) && l.kind === 'request').length;
  return [{
    id: 'env_mismatch', severity: 'high', count: bad.length, first_seen: bad[0].ts,
    title: `${keyEnv(bad[0].client_id) === 'sandbox' ? 'Sandbox' : 'Production'} credentials are calling ${bad[0].env}`,
    detail: `${bad.length} requests from client ${bad[0].client_id} were rejected with 401 invalid_client on ${bad[0].env}, ${Math.round(share * 100)}% of traffic since ${bad[0].ts}.` +
      (lastGood ? ` The last successful request came from ${lastGood.client_id} at ${lastGood.ts}, so the credentials changed between those two times.` : ''),
    evidence: bad.slice(0, 3).map(l => l.request_id),
    next_step: 'Check the environment variables in the latest deploy. Sandbox keys (nw_test_) only work against the sandbox base URL.',
  }];
}

/** One authorization code exchanged more than once. */
export function duplicateExchange(logs: LogEntry[]): Finding[] {
  const tok = logs.filter(l => l.endpoint === 'POST /v1/token' && l.code_fp);
  const groups = new Map<string, LogEntry[]>();
  for (const l of tok) groups.set(l.code_fp!, [...(groups.get(l.code_fp!) ?? []), l]);
  const dup = [...groups.values()].filter(g => g.length > 1 && g.some(x => x.status === 200) && g.some(x => x.error_code === 'code_reused'));
  const out: Finding[] = [];
  if (dup.length) {
    const gaps = dup.map(g => t(g[g.length - 1]) - t(g[0]));
    out.push({
      id: 'duplicate_code_exchange', severity: 'medium', count: dup.length, first_seen: dup[0][0].ts,
      title: 'The same authorization code is being exchanged twice',
      detail: `${dup.length} of ${groups.size} codes were exchanged more than once. The first exchange succeeded and the repeat failed with code_reused, a median ${pct(gaps, 50)} ms later. The connection worked; whatever showed the user the second response showed an error.`,
      evidence: dup.slice(0, 2).flatMap(g => g.map(x => x.request_id)),
      next_step: 'Make the callback idempotent: share one exchange per code, and treat code_reused as success when the session already has a token.',
    });
  }
  const expired = tok.filter(l => l.error_code === 'code_expired');
  if (expired.length) out.push({
    id: 'code_expired', severity: 'low', count: expired.length, first_seen: expired[0].ts,
    title: 'Codes exchanged after they expired', detail: `${expired.length} exchanges arrived more than 10 minutes after the code was issued.`,
    evidence: expired.slice(0, 3).map(l => l.request_id), next_step: 'Exchange the code as soon as the callback arrives; do not queue it behind other work.',
  });
  return out;
}

/** Bursts over the rate limit, and retries that ignore Retry-After. */
export function rateLimitBursts(logs: LogEntry[], limitPerSecond = 100): Finding[] {
  const limited = logs.filter(l => l.status === 429);
  if (!limited.length) return [];
  const reqs = logs.filter(l => l.kind === 'request');
  const sec = new Map<number, number>();
  for (const l of reqs) { const s = Math.floor(t(l) / 1000); sec.set(s, (sec.get(s) ?? 0) + 1); }
  const peak = Math.max(...sec.values());
  let tooSoon = 0;
  const lastLimited = new Map<string, LogEntry>();
  for (const l of reqs) {
    const k = `${l.client_id} ${l.path}`;
    const prev = lastLimited.get(k);
    if (prev && t(l) - t(prev) < (prev.retry_after_s ?? 1) * 1000) tooSoon++;
    if (l.status === 429) lastLimited.set(k, l); else lastLimited.delete(k);
  }
  const share = limited.length / reqs.length;
  return [{
    id: 'rate_limit_burst', severity: share > 0.2 ? 'high' : 'medium', count: limited.length, first_seen: limited[0].ts,
    title: 'Requests arrive in bursts above the rate limit',
    detail: `${limited.length} of ${reqs.length} requests (${Math.round(share * 100)}%) got 429. Peak was ${peak} requests in one second against a limit of ${limitPerSecond}. ${tooSoon} retries came back before Retry-After had passed, so they were limited again.`,
    evidence: limited.slice(0, 3).map(l => l.request_id),
    next_step: `Pace batch jobs below ${limitPerSecond} requests per second and wait for Retry-After before retrying. For daily re-checks, policy.updated webhooks remove most of the polling.`,
  }];
}

/** Webhook deliveries the customer's endpoint is rejecting. */
export function webhookRejected(logs: LogEntry[]): Finding[] {
  const dl = logs.filter(l => l.kind === 'webhook_delivery');
  const bad = dl.filter(l => l.status < 200 || l.status >= 300);
  if (!bad.length) return [];
  const events = new Set(bad.map(l => l.event_id));
  const delivered = new Set(dl.filter(l => l.status >= 200 && l.status < 300).map(l => l.event_id));
  const neverDelivered = [...events].filter(e => !delivered.has(e)).length;
  const statuses = [...new Set(bad.map(l => l.status))].join(', ');
  const sig = bad.every(l => l.status === 401 || l.status === 403);
  return [{
    id: 'webhook_rejected', severity: 'high', count: bad.length, first_seen: bad[0].ts,
    title: `The webhook endpoint ${bad[0].target} is rejecting deliveries`,
    detail: `${bad.length} delivery attempts failed (HTTP ${statuses}); ${neverDelivered} of ${new Set(dl.map(l => l.event_id)).size} events were never delivered after 3 attempts each. Northwind is sending; the endpoint is refusing.` +
      (sig ? ' A 401 from a webhook endpoint almost always means signature verification failed: the wrong secret, or the body was parsed and re-serialized before verifying.' : ''),
    evidence: bad.slice(0, 3).map(l => `${l.request_id} (event ${l.event_id}, attempt ${l.attempt})`),
    next_step: 'Verify the HMAC over the raw request body, exactly as received, with the endpoint secret from registration.',
  }];
}

/** Customer app logs: the app used a different policy than the one it asked about. */
export function policyMismatch(logs: LogEntry[], customer: any[]): Finding[] {
  const bad = customer.filter(e => e.event === 'rental_check' && e.policy_used !== e.policy_requested);
  if (!bad.length) return [];
  const served = new Set(logs.filter(l => l.status === 200 && l.policy_id).map(l => l.policy_id));
  const neverFetched = bad.filter(e => !served.has(e.policy_requested)).length;
  const evidence = bad.slice(0, 3).map(e => {
    const req = logs.find(l => l.policy_id === e.policy_used && l.status === 200);
    return `${e.policy_requested} requested, ${e.policy_used} used${req ? ` (served by ${req.request_id})` : ''}`;
  });
  return [{
    id: 'policy_mismatch', severity: 'high', count: bad.length, first_seen: bad[0].ts,
    title: 'The app checked a different policy than the renter booked with',
    detail: `${bad.length} rental checks used another policy from the same account. Northwind never received a request for ${neverFetched} of the requested policies, so the wrong data came from the app's side, not the API.`,
    evidence,
    next_step: 'Look at any cache between the app and Northwind: it should be keyed by policy ID, not account ID.',
  }];
}

export function detect(logs: LogEntry[], customer: any[] = [], opts: { limit?: number } = {}): Finding[] {
  const order = { high: 0, medium: 1, low: 2 };
  return [
    ...envMismatch(logs), ...duplicateExchange(logs), ...rateLimitBursts(logs, opts.limit),
    ...webhookRejected(logs), ...policyMismatch(logs, customer),
  ].sort((a, b) => order[a.severity] - order[b.severity]);
}
