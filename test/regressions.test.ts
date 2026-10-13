// One test per ticket: the code Contoso shipped reproduces the reported symptom and
// triage flags it; the fixed code does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIOS } from '../scripts/scenarios.ts';
import { detect } from '../tools/detectors.ts';

const ids = (r: { provider: any[]; customer: any[] }) => detect(r.provider, r.customer).map(f => f.id);

test('TCK-1041 sudden 401s: sandbox keys deployed to production', async () => {
  const bad = await SCENARIOS['TCK-1041']('buggy');
  assert.equal(bad.metrics.after_deploy_failed, 30);
  assert.deepEqual(ids(bad), ['env_mismatch']);
  const good = await SCENARIOS['TCK-1041']('fixed');
  assert.equal(good.metrics.deployed, false, 'the bad config now fails the deploy');
  assert.equal(good.metrics.after_deploy_failed, 0);
  assert.deepEqual(ids(good), []);
});

test('TCK-1042 "couldn\'t connect" shown to users who connected', async () => {
  const bad = await SCENARIOS['TCK-1042']('buggy');
  assert.equal(bad.metrics.shown_failure, bad.metrics.callback_fired_twice);
  assert.equal(bad.metrics.actually_connected, bad.metrics.users);
  assert.deepEqual(ids(bad), ['duplicate_code_exchange']);
  const good = await SCENARIOS['TCK-1042']('fixed');
  assert.equal(good.metrics.shown_failure, 0);
  assert.equal(good.provider.filter(l => l.endpoint === 'POST /v1/token').length, good.metrics.users, 'one exchange per code');
  assert.deepEqual(ids(good), []);
});

test('TCK-1043 morning re-check fails with 429s', async () => {
  const bad = await SCENARIOS['TCK-1043']('buggy');
  assert.ok(bad.metrics.failed > 50, `failed ${bad.metrics.failed}`);
  assert.deepEqual(ids(bad), ['rate_limit_burst']);
  const good = await SCENARIOS['TCK-1043']('fixed');
  assert.equal(good.metrics.failed, 0);
  assert.deepEqual(ids(good), []);
});

test('TCK-1044 webhooks rejected after a framework upgrade', async () => {
  const bad = await SCENARIOS['TCK-1044']('buggy');
  assert.equal(bad.metrics.delivered, 0);
  assert.deepEqual(ids(bad), ['webhook_rejected']);
  const good = await SCENARIOS['TCK-1044']('fixed');
  assert.equal(good.metrics.delivered, good.metrics.events);
  assert.equal(good.metrics.delivery_attempts, good.metrics.events, 'every event lands on the first attempt');
  assert.deepEqual(ids(good), []);
});

test('TCK-1045 wrong car: cache keyed by account', async () => {
  const bad = await SCENARIOS['TCK-1045']('buggy');
  assert.ok(bad.metrics.wrong_policy_used > 0);
  assert.equal(bad.metrics.declined, bad.metrics.wrong_policy_used);
  assert.deepEqual(ids(bad), ['policy_mismatch']);
  const good = await SCENARIOS['TCK-1045']('fixed');
  assert.equal(good.metrics.declined, 0);
  assert.deepEqual(ids(good), []);
});
