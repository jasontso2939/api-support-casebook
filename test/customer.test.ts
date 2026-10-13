// Unit tests for the fixed integration code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { loadConfig, ConfigError } from '../customer/config.ts';
import { handleWebhook } from '../customer/webhooks.ts';
import { decide } from '../customer/policies.ts';
import { createClient } from '../customer/northwind.ts';
import { startProvider, credentialsFor } from '../provider/server.ts';

const vars = (env: string, keys: 'sandbox' | 'production') => {
  const c = credentialsFor(keys);
  return { NORTHWIND_ENV: env, NORTHWIND_BASE_URL: 'http://x', NORTHWIND_CLIENT_ID: c.clientId, NORTHWIND_CLIENT_SECRET: c.clientSecret };
};

test('config refuses sandbox keys with NORTHWIND_ENV=production', () => {
  assert.throws(() => loadConfig(vars('production', 'sandbox')), ConfigError);
  assert.throws(() => loadConfig({ ...vars('production', 'production'), NORTHWIND_CLIENT_SECRET: 'sk_test_x' }), /secret is sandbox/);
  assert.equal(loadConfig(vars('production', 'production')).env, 'production');
  assert.throws(() => loadConfig({}), /NORTHWIND_ENV is not set/);
});

test('webhooks verify on the raw body, and reject a re-serialized one', () => {
  const secret = 'whsec_test', raw = '{"id": "evt_1", "type": "policy.updated"}', t = 1_800_000_000;
  const sig = `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`;
  assert.equal(handleWebhook({ rawBody: raw, parsedBody: JSON.parse(raw), signature: sig, secret, nowSec: t + 5 }).status, 200);
  assert.equal(handleWebhook({ rawBody: JSON.stringify(JSON.parse(raw)), parsedBody: null, signature: sig, secret, nowSec: t + 5 }).status, 401);
  assert.equal(handleWebhook({ rawBody: raw, parsedBody: null, signature: sig, secret, nowSec: t + 301 }).reason, 'timestamp outside tolerance');
  assert.equal(handleWebhook({ rawBody: raw, parsedBody: null, signature: undefined, secret, nowSec: t }).status, 400);
});

test('rental decision names every failed check', () => {
  const policy = { id: 'pol_1', status: 'active', vehicles: [{ vin: 'A' }], coverages: [{ code: 'BI', per_person: 25000 }] };
  assert.deepEqual(decide(policy, { vin: 'B', minBodilyInjuryPerPerson: 50000 }).reasons, ['vehicle not on policy', 'bodily injury limit too low']);
  assert.equal(decide({ ...policy, coverages: [{ code: 'BI', per_person: 100000 }] }, { vin: 'A', minBodilyInjuryPerPerson: 50000 }).approved, true);
});

test('the client waits at least as long as Retry-After before retrying', async () => {
  const p = await startProvider({ env: 'sandbox', rateLimit: { perSecond: 1, burst: 1 } });
  const waits: number[] = [];
  try {
    const client = createClient(loadConfig({ ...vars('sandbox', 'sandbox'), NORTHWIND_BASE_URL: p.url }), {
      sleep: async ms => { waits.push(ms); await new Promise(r => setTimeout(r, ms)); }, random: () => 0,
    });
    await client.request('POST', '/v1/connect/sessions', {});
    const r = await client.request('POST', '/v1/connect/sessions', {});
    assert.equal(r.status, 201);
    assert.equal(r.attempts, 2);
    assert.ok(waits[0] >= 1000, `waited ${waits[0]} ms`);
  } finally { await p.stop(); }
});
