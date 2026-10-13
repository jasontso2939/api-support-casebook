# TCK-1045: A renter's policy shows the wrong car

**Sev 2** · Data accuracy · opened Thu Oct 8, 15:25 PT · resolved Fri Oct 9, 11:00 PT · pattern: Customer-side cache keyed by account instead of policy

Reproduce it: `npm run repro -- TCK-1045 buggy`, then `npm run triage -- runs/TCK-1045/buggy/northwind.jsonl`. Regression test: `test/regressions.test.ts`.

## Report

> Some renters are getting declined with "vehicle not on policy" even though they're insured. One renter sent us her insurance card and the car is right there. Your API is returning the wrong vehicle for some policies.
>
> Marcus, Contoso Rentals product manager

## First response

> Hi Marcus, thanks for sending the card, that's exactly what I need to check this properly. Could you share the policy IDs for two declined renters and, if possible, your app logs for those bookings? I'll compare what Northwind returned with what your app used.

## Scope

Severity 2: a data-accuracy report. Wrongly declined renters lose bookings, and if the API were wrong it could affect every customer, so this needs a definite answer.

## Investigation

1. **Check what Northwind actually returned.** For the declined renters, every policy Northwind served had the right vehicle for that policy. No sign of wrong data from the API.
2. **Notice what's missing.** The policy each renter booked with was never requested at all. Northwind served a different policy from the same account.
3. **Compare with Contoso's logs.** Their rental check logged `policy_requested` and `policy_used`, and for the declined renters they differ. Every one of them has two cars on two policies.
4. **So the swap happened in the app.** Contoso caches policies to avoid repeat lookups, and the cache is keyed by account. The first policy fetched for an account (shown on the renter's profile page) answers for every policy in that account.

| Time (PT) | Request ID | Client | Endpoint | Status | Error | ms |
| --- | --- | --- | --- | --- | --- | --- |
| 13:44:00.055 | `req_e2a77c927771` | `nw_live_contoso` | POST /v1/token (code 119e83f6) | 200 |  | 7 |
| 13:44:00.062 | `req_a65590beb4ac` | `nw_live_contoso` | GET /v1/policies/pol_G3ppFp4DYN | 200 |  | 7 |

Contoso's app log for the same bookings:

| Time (PT) | Contoso event | Policy requested | Policy used | Approved | Reasons |
| --- | --- | --- | --- | --- | --- |
| 13:38:00.034 | rental_check | `pol_JvqAS9VmU0` | `pol_JvqAS9VmU0` | yes |  |
| 13:52:00.063 | rental_check | `pol_QQsM3nWg8U` | `pol_G3ppFp4DYN` | **no** | vehicle not on policy |
| 14:06:00.093 | rental_check | `pol_rvzfsBKDyT` | `pol_rvzfsBKDyT` | yes |  |
| 14:20:00.119 | rental_check | `pol_UWzje6qbFc` | `pol_UWzje6qbFc` | yes |  |
| 14:34:00.141 | rental_check | `pol_o0okSbuOMF` | `pol_TKsevROMCG` | **no** | vehicle not on policy |
| 14:48:00.168 | rental_check | `pol_57E6cyKrQz` | `pol_57E6cyKrQz` | yes |  |
| 15:02:00.186 | rental_check | `pol_E0ntuzOFAP` | `pol_E0ntuzOFAP` | yes |  |
| 15:16:00.218 | rental_check | `pol_jBjYU0eFiA` | `pol_gEc0sbvnHC` | **no** | vehicle not on policy |

```text
Northwind triage · 32 requests, 0 webhook deliveries · 2026-10-08 20:30:00 to 2026-10-08 22:08:00 UTC

ENDPOINT                        REQS   2xx   4xx   5xx  p50 ms  p95 ms
POST /v1/connect/sessions          8     8     0     0       6       9
POST /v1/simulate/consent          8     8     0     0       7       9
POST /v1/token                     8     8     0     0       7       9
GET /v1/policies/:id               8     8     0     0       7      10

ERRORS  none

FINDINGS (1)
  [high] The app checked a different policy than the renter booked with
    3 rental checks used another policy from the same account. Northwind never received a request for 3 of the requested policies, so the wrong data came from the app's side, not the API.
    first seen 2026-10-08T20:52:00.063Z
    evidence: pol_QQsM3nWg8U requested, pol_G3ppFp4DYN used (served by req_a65590beb4ac), pol_o0okSbuOMF requested, pol_TKsevROMCG used (served by req_91e5d7079fcd), pol_jBjYU0eFiA requested, pol_gEc0sbvnHC used (served by req_58dc76ca79e5)
    next: Look at any cache between the app and Northwind: it should be keyed by policy ID, not account ID.
```

## Root cause

Contoso's policy cache used the account ID as its key. For renters with more than one policy, the rental check got whichever policy had been cached first.

## Fix

Key the cache by account and policy ID.

```diff
--- tickets/TCK-1045-wrong-vehicle/buggy.ts (what shipped)
+++ customer/policies.ts (fixed)
 export function createPolicyService(client: Client) {
   const cache = new Map<string, any>();
   async function getPolicy(token: string, accountId: string, policyId: string) {
-    if (cache.has(accountId)) return { policy: cache.get(accountId), requestId: null, cached: true };
+    const key = `${accountId}:${policyId}`;
+    if (cache.has(key)) return { policy: cache.get(key), requestId: null, cached: true };
     const r = await client.request('GET', `/v1/policies/${policyId}`, undefined, token);
     if (r.status !== 200) throw new Error(`policy lookup failed: ${r.status} ${r.data?.error?.code} (${r.requestId})`);
-    cache.set(accountId, r.data);
+    cache.set(key, r.data);
     return { policy: r.data, requestId: r.requestId, cached: false };
   }
   return { getPolicy, cache };
 }
```

## Verified

Same renters with the fix: wrong-policy checks went from 3 to 0, and wrongful declines from 3 to 0.

## Reply to the customer

> Hi Marcus, I traced the declined bookings and the API returned the correct vehicle for every policy it was asked about. The catch is that it was never asked about the policy those renters booked with. All the affected renters have two cars on two separate policies, and your policy cache is keyed by account, so the rental check reused the first policy it had cached.
>
> Keying the cache by policy ID fixes it; the change is attached. Those renters should pass if you re-run their checks after the fix ships.

## Internal note

- Northwind data verified correct; no API defect. Closed with the customer's agreement.
- Every renter with two policies hit this (3 of 8 in the sample), so it would have kept recurring.

## Prevent it next time

- **Docs:** call out that one account can hold several policies, each with its own vehicles.
- **Detection:** with the customer's logs, `policy_mismatch` compares what was requested with what was used and shows whether the API ever saw the request.
