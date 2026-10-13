// The policy cache before the fix: keyed by account, so the first policy fetched for an
// account answered for every policy in it.
import type { Client } from '../../customer/northwind.ts';

export function createPolicyService(client: Client) {
  const cache = new Map<string, any>();
  async function getPolicy(token: string, accountId: string, policyId: string) {
    if (cache.has(accountId)) return { policy: cache.get(accountId), requestId: null, cached: true };
    const r = await client.request('GET', `/v1/policies/${policyId}`, undefined, token);
    if (r.status !== 200) throw new Error(`policy lookup failed: ${r.status} ${r.data?.error?.code} (${r.requestId})`);
    cache.set(accountId, r.data);
    return { policy: r.data, requestId: r.requestId, cached: false };
  }
  return { getPolicy, cache };
}
