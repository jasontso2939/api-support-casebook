// Detector edge cases on hand-written logs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detect, rateLimitBursts, summarize } from '../tools/detectors.ts';

const base = { kind: 'request', env: 'production', client_id: 'nw_live_contoso', method: 'GET', latency_ms: 5 } as const;
const at = (s: number) => new Date(Date.UTC(2026, 9, 6, 16, 0, 0) + s * 1000).toISOString();

test('clean logs produce no findings', () => {
  const logs: any[] = Array.from({ length: 20 }, (_, i) => ({ ...base, ts: at(i), request_id: `req_${i}`, endpoint: 'GET /v1/policies/:id', path: `/v1/policies/pol_${i}`, status: 200 }));
  assert.deepEqual(detect(logs), []);
  assert.equal(summarize(logs).peak_per_second, 1);
});

test('a retry that waits for Retry-After is not counted as too soon', () => {
  const p = '/v1/policies/pol_AAAAAAAAAA';
  const logs: any[] = [
    { ...base, ts: at(0), request_id: 'a', endpoint: 'GET /v1/policies/:id', path: p, status: 429, error_code: 'rate_limited', retry_after_s: 1 },
    { ...base, ts: at(0.2), request_id: 'b', endpoint: 'GET /v1/policies/:id', path: p, status: 429, error_code: 'rate_limited', retry_after_s: 1 },
    { ...base, ts: at(1.5), request_id: 'c', endpoint: 'GET /v1/policies/:id', path: p, status: 200 },
  ];
  const [f] = rateLimitBursts(logs, 100);
  assert.match(f.detail, /1 retries came back before Retry-After/);
});

test('webhook 5xx from the endpoint is reported without the signature hint', () => {
  const logs: any[] = [1, 2, 3].map(a => ({ ...base, kind: 'webhook_delivery', ts: at(a), request_id: `d${a}`, endpoint: 'webhook', path: '/h', target: '/h', status: 503, error_code: 'endpoint_rejected', event_id: 'evt_1', attempt: a }));
  const [f] = detect(logs);
  assert.equal(f.id, 'webhook_rejected');
  assert.doesNotMatch(f.detail, /signature/);
});
