// Contoso's morning job: re-check every active rental's insurance before pickup.
import type { Client } from './northwind.ts';

export interface RecheckItem { token: string; policyId: string }
export interface RecheckResult { checked: number; failed: number; failures: { policyId: string; status: number; requestId: string | null }[] }

/**
 * Fix for TCK-1043: paced under the plan's rate limit with a small token bucket,
 * a bounded worker pool, and the client's Retry-After-aware retries as a backstop.
 */
export async function recheckAll(client: Client, items: RecheckItem[], opts: { perSecond?: number; concurrency?: number } = {}): Promise<RecheckResult> {
  const perSecond = opts.perSecond ?? 80;          // plan limit is 100/s; leave headroom
  const concurrency = opts.concurrency ?? 8;
  let tokens = perSecond, last = Date.now();
  const acquire = async () => {
    for (;;) {
      const t = Date.now();
      tokens = Math.min(perSecond, tokens + ((t - last) / 1000) * perSecond); last = t;
      if (tokens >= 1) { tokens -= 1; return; }
      await new Promise(r => setTimeout(r, Math.ceil(((1 - tokens) / perSecond) * 1000)));
    }
  };
  const result: RecheckResult = { checked: 0, failed: 0, failures: [] };
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const it = items[next++];
      await acquire();
      const r = await client.request('GET', `/v1/policies/${it.policyId}`, undefined, it.token);
      result.checked++;
      if (r.status !== 200) { result.failed++; result.failures.push({ policyId: it.policyId, status: r.status, requestId: r.requestId }); }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return result;
}
