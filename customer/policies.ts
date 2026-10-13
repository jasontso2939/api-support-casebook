// Looking up a renter's policy and deciding whether it covers the rental.
import type { Client } from './northwind.ts';

export interface RentalRules { vin: string; minBodilyInjuryPerPerson: number }
export interface Decision { approved: boolean; reasons: string[]; policyId: string; vinsOnPolicy: string[] }

/**
 * Fix for TCK-1045: cache by policy ID. The old cache was keyed by account ID, so a
 * renter with two cars on two policies always got whichever policy was fetched first.
 */
export function createPolicyService(client: Client) {
  const cache = new Map<string, any>();
  async function getPolicy(token: string, accountId: string, policyId: string) {
    const key = `${accountId}:${policyId}`;
    if (cache.has(key)) return { policy: cache.get(key), requestId: null, cached: true };
    const r = await client.request('GET', `/v1/policies/${policyId}`, undefined, token);
    if (r.status !== 200) throw new Error(`policy lookup failed: ${r.status} ${r.data?.error?.code} (${r.requestId})`);
    cache.set(key, r.data);
    return { policy: r.data, requestId: r.requestId, cached: false };
  }
  return { getPolicy, cache };
}

export function decide(policy: any, rules: RentalRules): Decision {
  const reasons: string[] = [];
  const vins = (policy.vehicles ?? []).map((v: any) => v.vin);
  if (policy.status !== 'active') reasons.push('policy not active');
  if (!vins.includes(rules.vin)) reasons.push('vehicle not on policy');
  const bi = (policy.coverages ?? []).find((c: any) => c.code === 'BI');
  if (!bi || (bi.per_person ?? 0) < rules.minBodilyInjuryPerPerson) reasons.push('bodily injury limit too low');
  return { approved: reasons.length === 0, reasons, policyId: policy.id, vinsOnPolicy: vins };
}
