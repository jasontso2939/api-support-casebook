// Each ticket's scenario: real traffic between Contoso's integration and the Northwind
// API, run once with the code Contoso shipped ("buggy") and once with the fix.
import http from 'node:http';
import { startProvider, credentialsFor } from '../provider/server.ts';
import { makeAccount } from '../provider/fixtures.ts';
import type { LogEntry, Provider } from '../provider/server.ts';
import { createClient } from '../customer/northwind.ts';
import type { Client } from '../customer/northwind.ts';
import * as fixedConfig from '../customer/config.ts';
import * as fixedConnect from '../customer/connect.ts';
import * as fixedRecheck from '../customer/recheck.ts';
import * as fixedWebhooks from '../customer/webhooks.ts';
import * as fixedPolicies from '../customer/policies.ts';
import * as bug1041 from '../tickets/TCK-1041-sudden-401s/buggy.ts';
import * as bug1042 from '../tickets/TCK-1042-connect-shows-failure/buggy.ts';
import * as bug1043 from '../tickets/TCK-1043-morning-429s/buggy.ts';
import * as bug1044 from '../tickets/TCK-1044-webhooks-stopped/buggy.ts';
import * as bug1045 from '../tickets/TCK-1045-wrong-vehicle/buggy.ts';

export type Variant = 'buggy' | 'fixed';
export interface RunResult { ticket: string; variant: Variant; provider: LogEntry[]; customer: any[]; metrics: Record<string, any> }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function appLog(p: Provider, out: any[]) {
  return (event: string, fields: Record<string, unknown> = {}) => out.push({ ts: new Date(p.now()).toISOString(), app: 'contoso-rentals', event, ...fields });
}

function liveVars(p: Provider) {
  const c = credentialsFor(p.env);
  return { NORTHWIND_ENV: p.env, NORTHWIND_BASE_URL: p.url, NORTHWIND_CLIENT_ID: c.clientId, NORTHWIND_CLIENT_SECRET: c.clientSecret };
}

/** Starts a connect session and plays the end user finishing it (test harness endpoint). */
async function connectUser(client: Client, userRef: string, policies = 1) {
  const s = await client.request('POST', '/v1/connect/sessions', { user_ref: userRef });
  const c = await client.request('POST', '/v1/simulate/consent', { session_id: s.data.session_id, policies });
  return { sessionId: s.data.session_id as string, code: c.data.code as string };
}

async function connectAndExchange(client: Client, userRef: string, policies = 1) {
  const { code } = await connectUser(client, userRef, policies);
  const t = await client.request('POST', '/v1/token', { code });
  return { token: t.data.access_token as string, accountId: t.data.account_id as string, policyIds: t.data.policy_ids as string[] };
}

const fastSleep = { sleep: (ms: number) => sleep(Math.min(ms, 1200)) };

// TCK-1041: every verification fails with 401 right after a deploy.
export async function run1041(variant: Variant): Promise<RunResult> {
  const p = await startProvider({ env: 'production', clockBase: '2026-10-01T16:58:00Z', seed: '1041' });
  const customer: any[] = []; const log = appLog(p, customer);
  try {
    let client = createClient(fixedConfig.loadConfig(liveVars(p)), fastSleep);
    const renters = [];
    for (let i = 0; i < 12; i++) renters.push(await connectAndExchange(client, `renter-1041-${i}`));
    for (const r of renters) { await client.request('GET', `/v1/policies/${r.policyIds[0]}`, undefined, r.token); p.advance(205_000); }

    p.advance(Date.parse('2026-10-01T17:42:00Z') - p.now());            // 10:42 PT: v2.8.0 deploys
    const staging = credentialsFor('sandbox');                          // the staging .env got promoted
    const deployVars = { ...liveVars(p), NORTHWIND_CLIENT_ID: staging.clientId, NORTHWIND_CLIENT_SECRET: staging.clientSecret };
    let deployed = true;
    try {
      const cfg = (variant === 'buggy' ? bug1041 : fixedConfig).loadConfig(deployVars);
      client = createClient(cfg, fastSleep);
      log('deploy', { version: '2.8.0', result: 'started' });
    } catch (e) {
      deployed = false;
      log('deploy', { version: '2.8.0', result: 'failed_preflight', error: (e as Error).message });
    }
    let ok = 0, failed = 0;
    for (let i = 0; i < 30; i++) {
      const r = renters[i % renters.length];
      const res = i % 3 === 0
        ? await client.request('POST', '/v1/connect/sessions', { user_ref: `renter-1041-new-${i}` })
        : await client.request('GET', `/v1/policies/${r.policyIds[0]}`, undefined, r.token);
      if (res.status < 300) ok++; else { failed++; log('northwind_error', { status: res.status, code: res.data?.error?.code, request_id: res.requestId }); }
      p.advance(20_000);
    }
    return { ticket: 'TCK-1041', variant, provider: p.logs, customer, metrics: { deployed, after_deploy_requests: 30, after_deploy_ok: ok, after_deploy_failed: failed } };
  } finally { await p.stop(); }
}

// TCK-1042: some renters see "couldn't connect" even though they connected.
export async function run1042(variant: Variant): Promise<RunResult> {
  const p = await startProvider({ env: 'production', clockBase: '2026-10-03T19:05:00Z', seed: '1042' });
  const customer: any[] = []; const log = appLog(p, customer);
  const complete = variant === 'buggy' ? bug1042.completeConnect : fixedConnect.completeConnect;
  try {
    const client = createClient(fixedConfig.loadConfig(liveVars(p)), fastSleep);
    const store = fixedConnect.newConnectStore();
    let shownFailure = 0, doubled = 0;
    const users = 40;
    for (let i = 0; i < users; i++) {
      const { sessionId, code } = await connectUser(client, `renter-1042-${i}`);
      const fireTwice = i % 5 === 3;                                   // reload or re-render on the callback page
      let shown;
      if (fireTwice) {
        doubled++;
        const [, second] = await Promise.all([complete(client, store, sessionId, code), sleep(15).then(() => complete(client, store, sessionId, code))]);
        shown = second;                                                // the page shows the latest call
      } else {
        shown = await complete(client, store, sessionId, code);
      }
      if (!shown.ok) { shownFailure++; log('connect_failed_shown', { session_id: sessionId, error_code: shown.errorCode, request_id: shown.requestId, has_token: store.tokens.has(sessionId) }); }
      p.advance(90_000);
    }
    return { ticket: 'TCK-1042', variant, provider: p.logs, customer, metrics: { users, callback_fired_twice: doubled, shown_failure: shownFailure, actually_connected: store.tokens.size } };
  } finally { await p.stop(); }
}

// TCK-1043: the 9 a.m. re-check job fails for hundreds of renters.
export async function run1043(variant: Variant): Promise<RunResult> {
  const p = await startProvider({ env: 'production', clockBase: '2026-10-05T23:00:00Z', seed: '1043', rateLimit: { perSecond: 100, burst: 100 } });
  const customer: any[] = []; const log = appLog(p, customer);
  try {
    const client = createClient(fixedConfig.loadConfig(liveVars(p)), fastSleep);
    const items: { token: string; policyId: string }[] = [];
    for (let b = 0; b < 300; b += 15) {                                // renters connected over the previous day
      const batch = await Promise.all(Array.from({ length: 15 }, (_, k) => connectAndExchange(client, `renter-1043-${b + k}`)));
      for (const r of batch) items.push({ token: r.token, policyId: r.policyIds[0] });
      await sleep(250);
    }
    await sleep(1100);
    const setupLogs = p.logs.length;
    p.advance(Date.parse('2026-10-06T16:00:00Z') - p.now());           // 9:00 PT
    log('job_start', { job: 'morning-recheck', items: items.length });
    const t0 = Date.now();
    const res = variant === 'buggy' ? await bug1043.recheckAll(client, items) : await fixedRecheck.recheckAll(client, items);
    log('job_end', { job: 'morning-recheck', checked: res.checked, failed: res.failed, seconds: (Date.now() - t0) / 1000 });
    for (const f of res.failures.slice(0, 5)) log('recheck_failed', { policy_id: f.policyId, status: f.status, request_id: f.requestId });
    const job = p.logs.slice(setupLogs);
    return { ticket: 'TCK-1043', variant, provider: job, customer, metrics: { renters: items.length, failed: res.failed, job_seconds: Math.round((Date.now() - t0) / 100) / 10, requests: job.length, rate_limited: job.filter(l => l.status === 429).length } };
  } finally { await p.stop(); }
}

// TCK-1044: policy webhooks "stopped arriving".
export async function run1044(variant: Variant): Promise<RunResult> {
  const p = await startProvider({ env: 'production', clockBase: '2026-10-07T15:00:00Z', seed: '1044' });
  const customer: any[] = []; const log = appLog(p, customer);
  const handle = variant === 'buggy' ? bug1044.handleWebhook : fixedWebhooks.handleWebhook;
  let secret = '';
  const received: string[] = [];
  const hookServer = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const parsedBody = JSON.parse(rawBody);                             // the framework's JSON body parser
    const out = handle({ rawBody, parsedBody, signature: req.headers['northwind-signature'] as string, secret, nowSec: Math.floor(p.now() / 1000) });
    if (out.status === 200) received.push(String(req.headers['northwind-event-id']));
    else log('webhook_rejected', { status: out.status, reason: out.reason, event_id: req.headers['northwind-event-id'] });
    res.writeHead(out.status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: out.status === 200 }));
  });
  await new Promise<void>(ok => hookServer.listen(0, '127.0.0.1', () => ok()));
  try {
    const client = createClient(fixedConfig.loadConfig(liveVars(p)), fastSleep);
    const reg = await client.request('POST', '/v1/webhooks', { url: `http://127.0.0.1:${(hookServer.address() as any).port}/hooks/northwind`, events: ['policy.updated'] });
    secret = reg.data.secret;
    const renters = [];
    for (let i = 0; i < 10; i++) renters.push(await connectAndExchange(client, `renter-1044-${i}`));
    p.advance(3 * 3600 * 1000);
    for (let i = 0; i < 10; i++) {
      const change = i % 3 === 0 ? { status: 'cancelled' } : { coverages_changed: ['COLL'] };
      await client.request('POST', '/v1/simulate/policy-event', { policy_id: renters[i].policyIds[0], change });
      p.advance(17 * 60 * 1000);
    }
    const deliveries = p.logs.filter(l => l.kind === 'webhook_delivery');
    return { ticket: 'TCK-1044', variant, provider: p.logs, customer, metrics: { events: 10, delivered: received.length, delivery_attempts: deliveries.length, rejected_attempts: deliveries.filter(d => d.status !== 200).length } };
  } finally { await p.stop(); hookServer.closeAllConnections?.(); await new Promise(ok => hookServer.close(() => ok(null))); }
}

// TCK-1045: a renter's policy shows the wrong car.
export async function run1045(variant: Variant): Promise<RunResult> {
  const p = await startProvider({ env: 'production', clockBase: '2026-10-08T20:30:00Z', seed: '1045' });
  const customer: any[] = []; const log = appLog(p, customer);
  try {
    const client = createClient(fixedConfig.loadConfig(liveVars(p)), fastSleep);
    const svc = (variant === 'buggy' ? bug1045 : fixedPolicies).createPolicyService(client);
    let declined = 0, wrongPolicy = 0, rentals = 0;
    for (let i = 0; i < 8; i++) {
      const cars = i % 3 === 1 ? 2 : 1;                                 // some renters insure two cars on two policies
      const acct = await connectAndExchange(client, `renter-1045-${i}`, cars);
      const first = await svc.getPolicy(acct.token, acct.accountId, acct.policyIds[0]);      // shown on the profile page
      log('profile_policy_shown', { account_id: acct.accountId, policy_id: first.policy.id });
      p.advance(8 * 60 * 1000);
      const wanted = acct.policyIds[cars - 1];                          // the car they actually booked with
      const truth = makeAccount(`renter-1045-${i}`, cars).policies.find(x => x.id === wanted)!;   // the car on the rental agreement
      const got = await svc.getPolicy(acct.token, acct.accountId, wanted);
      const d = fixedPolicies.decide(got.policy, { vin: truth.vehicles[0].vin, minBodilyInjuryPerPerson: 50000 });
      rentals++;
      if (!d.approved) declined++;
      if (got.policy.id !== wanted) wrongPolicy++;
      log('rental_check', { account_id: acct.accountId, policy_requested: wanted, policy_used: got.policy.id, cached: got.cached, vin: truth.vehicles[0].vin, approved: d.approved, reasons: d.reasons });
      p.advance(6 * 60 * 1000);
    }
    return { ticket: 'TCK-1045', variant, provider: p.logs, customer, metrics: { rentals, declined, wrong_policy_used: wrongPolicy } };
  } finally { await p.stop(); }
}

export const SCENARIOS: Record<string, (v: Variant) => Promise<RunResult>> = {
  'TCK-1041': run1041, 'TCK-1042': run1042, 'TCK-1043': run1043, 'TCK-1044': run1044, 'TCK-1045': run1045,
};
