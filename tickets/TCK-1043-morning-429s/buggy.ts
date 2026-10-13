// The morning job before the fix: every policy at once, and immediate retries that
// ignore Retry-After.
import type { Client } from '../../customer/northwind.ts';
import type { RecheckItem, RecheckResult } from '../../customer/recheck.ts';

export async function recheckAll(client: Client, items: RecheckItem[]): Promise<RecheckResult> {
  const result: RecheckResult = { checked: 0, failed: 0, failures: [] };
  await Promise.all(items.map(async it => {
    let r = await client.once('GET', `/v1/policies/${it.policyId}`, undefined, it.token);
    for (let i = 0; i < 2 && r.status === 429; i++) {
      r = await client.once('GET', `/v1/policies/${it.policyId}`, undefined, it.token);   // retry right away
    }
    result.checked++;
    if (r.status !== 200) { result.failed++; result.failures.push({ policyId: it.policyId, status: r.status, requestId: r.requestId }); }
  }));
  return result;
}
