// The mock API behaves like the real thing in the ways support tickets depend on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startProvider, credentialsFor, sign } from '../provider/server.ts';

async function call(url: string, path: string, init: { method?: string; body?: unknown; env?: 'sandbox' | 'production'; token?: string; creds?: { clientId: string; clientSecret: string } } = {}) {
  const c = init.creds ?? credentialsFor(init.env ?? 'sandbox');
  const headers: Record<string, string> = { 'x-client-id': c.clientId, 'x-client-secret': c.clientSecret, 'content-type': 'application/json' };
  if (init.token) headers['x-access-token'] = init.token;
  const res = await fetch(url + path, { method: init.method ?? 'GET', headers, body: init.body ? JSON.stringify(init.body) : undefined });
  return { status: res.status, rid: res.headers.get('x-request-id'), retryAfter: res.headers.get('retry-after'), data: await res.json() };
}

async function connected(url: string, policies = 1) {
  const s = await call(url, '/v1/connect/sessions', { method: 'POST', body: { user_ref: 'u1' } });
  const c = await call(url, '/v1/simulate/consent', { method: 'POST', body: { session_id: s.data.session_id, policies } });
  return c.data.code as string;
}

test('credentials only work in their own environment, and errors carry a request ID', async () => {
  const p = await startProvider({ env: 'production' });
  try {
    const r = await call(p.url, '/v1/connect/sessions', { method: 'POST', body: {}, creds: credentialsFor('sandbox') });
    assert.equal(r.status, 401);
    assert.equal(r.data.error.code, 'invalid_client');
    assert.match(r.rid!, /^req_[0-9a-f]{12}$/);
    assert.equal(r.data.error.request_id, r.rid);
    assert.equal(p.logs.at(-1)!.client_id, 'nw_test_contoso');
  } finally { await p.stop(); }
});

test('an authorization code works once', async () => {
  const p = await startProvider({ env: 'sandbox' });
  try {
    const code = await connected(p.url);
    assert.equal((await call(p.url, '/v1/token', { method: 'POST', body: { code } })).status, 200);
    const again = await call(p.url, '/v1/token', { method: 'POST', body: { code } });
    assert.equal(again.status, 400);
    assert.equal(again.data.error.code, 'code_reused');
    assert.ok(!JSON.stringify(p.logs).includes(code), 'raw codes never reach the logs');
  } finally { await p.stop(); }
});

test('an authorization code expires after 10 minutes', async () => {
  const p = await startProvider({ env: 'sandbox' });
  try {
    const code = await connected(p.url);
    p.advance(10 * 60 * 1000 + 1);
    const r = await call(p.url, '/v1/token', { method: 'POST', body: { code } });
    assert.equal(r.data.error.code, 'code_expired');
  } finally { await p.stop(); }
});

test('a token reads only its own account, and malformed IDs are 404 invalid_id', async () => {
  const p = await startProvider({ env: 'sandbox' });
  try {
    const a = (await call(p.url, '/v1/token', { method: 'POST', body: { code: await connected(p.url) } })).data;
    const s = await call(p.url, '/v1/connect/sessions', { method: 'POST', body: { user_ref: 'someone-else' } });
    const c = await call(p.url, '/v1/simulate/consent', { method: 'POST', body: { session_id: s.data.session_id } });
    const b = (await call(p.url, '/v1/token', { method: 'POST', body: { code: c.data.code } })).data;
    assert.equal((await call(p.url, `/v1/policies/${a.policy_ids[0]}`, { token: a.access_token })).status, 200);
    assert.equal((await call(p.url, `/v1/policies/${b.policy_ids[0]}`, { token: a.access_token })).data.error.code, 'policy_forbidden');
    assert.equal((await call(p.url, `/v1/policies/${a.policy_ids[0]}`)).data.error.code, 'token_missing');
    assert.equal((await call(p.url, '/v1/policies/POL-123', { token: a.access_token })).data.error.code, 'invalid_id');
  } finally { await p.stop(); }
});

test('bursts over the limit get 429 with Retry-After', async () => {
  const p = await startProvider({ env: 'sandbox', rateLimit: { perSecond: 5, burst: 5 } });
  try {
    const rs = await Promise.all(Array.from({ length: 12 }, () => call(p.url, '/v1/connect/sessions', { method: 'POST', body: {} })));
    const limited = rs.filter(r => r.status === 429);
    assert.equal(rs.filter(r => r.status === 201).length, 5);
    assert.equal(limited.length, 7);
    assert.ok(Number(limited[0].retryAfter) >= 1);
  } finally { await p.stop(); }
});

test('webhooks are signed over the exact bytes sent', async () => {
  const p = await startProvider({ env: 'sandbox' });
  const http = await import('node:http');
  let got: { raw: string; sig: string } | null = null;
  const srv = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    got = { raw, sig: String(req.headers['northwind-signature']) };
    res.writeHead(200); res.end();
  });
  await new Promise<void>(ok => srv.listen(0, '127.0.0.1', () => ok()));
  try {
    const reg = await call(p.url, '/v1/webhooks', { method: 'POST', body: { url: `http://127.0.0.1:${(srv.address() as any).port}/h` } });
    const tok = (await call(p.url, '/v1/token', { method: 'POST', body: { code: await connected(p.url) } })).data;
    await call(p.url, '/v1/simulate/policy-event', { method: 'POST', body: { policy_id: tok.policy_ids[0] } });
    assert.ok(got);
    const { raw, sig } = got!;
    const [t, v1] = sig.split(',').map(x => x.split('=')[1]);
    assert.equal(v1, sign(reg.data.secret, Number(t), raw));
    assert.notEqual(raw, JSON.stringify(JSON.parse(raw)), 'bodies use ", " separators, so re-serializing changes them');
  } finally { await p.stop(); srv.close(); }
});
