# TCK-1043: The 9 a.m. re-check job fails for hundreds of renters

**Sev 2** · Rate limits · opened Tue Oct 6, 09:12 PT · resolved Tue Oct 6, 15:40 PT · pattern: Burst traffic over the rate limit, retries ignoring Retry-After

Reproduce it: `npm run repro -- TCK-1043 buggy`, then `npm run triage -- runs/TCK-1043/buggy/northwind.jsonl`. Regression test: `test/regressions.test.ts`.

## Report

> Every morning our job that re-checks insurance for the day's pickups fails for a big chunk of renters with 429 errors. We're on the plan with 100 requests per second and we only check about 300 policies, so we shouldn't be anywhere near the limit. Can you raise it?
>
> Dana, Contoso Rentals backend lead

## First response

> Hi Dana, thanks for the clear report. Before we talk limits, I want to look at how the requests arrive, because 300 checks can still trip a per-second limit if they all land at once. I'll pull this morning's job traffic and send you what I see by midday.

## Scope

Severity 2: a daily job fails for about half its renters, so front-desk staff check them by hand. Not an outage, and nothing else is affected.

## Investigation

1. **Look at volume per second, not per day.** The whole job hit Northwind inside one second: a peak of 662 requests against a limit of 100.
2. **Count the 429s.** 528 of 662 requests were rate limited.
3. **Check the retries.** Each limited request was retried immediately, twice, without waiting for the `Retry-After` header, so the retries were limited too. That's why the failures stuck.
4. **The limit isn't the problem.** 300 checks at 80 per second takes under 4 seconds. The job just needs to pace itself.

| Time (PT) | Request ID | Client | Endpoint | Status | Error | ms |
| --- | --- | --- | --- | --- | --- | --- |
| 09:00:00.093 | `req_910c89d64da5` | `nw_live_contoso` | GET /v1/policies/pol_SyZ1cK3W2L | 200 |  | 4 |
| 09:00:00.093 | `req_f0f227a5caf6` | `nw_live_contoso` | GET /v1/policies/pol_BEcznGUzlh | 200 |  | 2 |
| 09:00:00.094 | `req_b42f11eb979c` | `nw_live_contoso` | GET /v1/policies/pol_B1dhFdhnNT | 429 | rate_limited | 0 |
| 09:00:00.095 | `req_04f962f98072` | `nw_live_contoso` | GET /v1/policies/pol_e0O8ogOtLP | 429 | rate_limited | 0 |
| 09:00:00.095 | `req_c5425f556af7` | `nw_live_contoso` | GET /v1/policies/pol_B1dhFdhnNT | 429 | rate_limited | 0 |
| 09:00:00.097 | `req_d128224c77c0` | `nw_live_contoso` | GET /v1/policies/pol_B1dhFdhnNT | 429 | rate_limited | 0 |

```text
Northwind triage · 662 requests, 0 webhook deliveries · 2026-10-06 16:00:00 to 2026-10-06 16:00:00 UTC

ENDPOINT                        REQS   2xx   4xx   5xx  p50 ms  p95 ms
GET /v1/policies/:id             662   134   528     0       0      13

ERRORS
  429 rate_limited                  528

FINDINGS (1)
  [high] Requests arrive in bursts above the rate limit
    528 of 662 requests (80%) got 429. Peak was 662 requests in one second against a limit of 100. 362 retries came back before Retry-After had passed, so they were limited again.
    first seen 2026-10-06T16:00:00.094Z
    evidence: req_b42f11eb979c, req_04f962f98072, req_c5425f556af7
    next: Pace batch jobs below 100 requests per second and wait for Retry-After before retrying. For daily re-checks, policy.updated webhooks remove most of the polling.
```

## Root cause

The job started every check at once (`Promise.all` over all policies) and retried 429s instantly. It used about 300 requests' worth of the limit in a few milliseconds, then spent its retries inside the same second.

## Fix

Pace the job under the limit with a small token bucket and a worker pool, and let the API client honor `Retry-After` as a backstop.

```diff
--- tickets/TCK-1043-morning-429s/buggy.ts (what shipped)
+++ customer/recheck.ts (fixed)
-export async function recheckAll(client: Client, items: RecheckItem[]): Promise<RecheckResult> {
+export async function recheckAll(client: Client, items: RecheckItem[], opts: { perSecond?: number; concurrency?: number } = {}): Promise<RecheckResult> {
+  const perSecond = opts.perSecond ?? 80;          // plan limit is 100/s; leave headroom
+  const concurrency = opts.concurrency ?? 8;
+  let tokens = perSecond, last = Date.now();
+  const acquire = async () => {
+    for (;;) {
+      const t = Date.now();
+      tokens = Math.min(perSecond, tokens + ((t - last) / 1000) * perSecond); last = t;
+      if (tokens >= 1) { tokens -= 1; return; }
+      await new Promise(r => setTimeout(r, Math.ceil(((1 - tokens) / perSecond) * 1000)));
+    }
+  };
   const result: RecheckResult = { checked: 0, failed: 0, failures: [] };
-  await Promise.all(items.map(async it => {
-    let r = await client.once('GET', `/v1/policies/${it.policyId}`, undefined, it.token);
-    for (let i = 0; i < 2 && r.status === 429; i++) {
-      r = await client.once('GET', `/v1/policies/${it.policyId}`, undefined, it.token);   // retry right away
+  let next = 0;
+  const worker = async () => {
+    while (next < items.length) {
+      const it = items[next++];
+      await acquire();
+      const r = await client.request('GET', `/v1/policies/${it.policyId}`, undefined, it.token);
+      result.checked++;
+      if (r.status !== 200) { result.failed++; result.failures.push({ policyId: it.policyId, status: r.status, requestId: r.requestId }); }
     }
-    result.checked++;
-    if (r.status !== 200) { result.failed++; result.failures.push({ policyId: it.policyId, status: r.status, requestId: r.requestId }); }
-  }));
+  };
+  await Promise.all(Array.from({ length: concurrency }, worker));
   return result;
 }
```

## Verified

Same 300 renters with the fix: failures went from 166 to 0, rate-limited requests from 528 to 0, and the job takes 2.8 seconds.

## Reply to the customer

> Hi Dana, good news: you don't need a higher limit. The job sends all 300 checks in the same instant, which is about 3x the per-second limit, and then retries immediately, so the retries get limited too.
>
> Two changes fix it. Pace the job at about 80 requests per second (it still finishes in under 4 seconds), and wait for the `Retry-After` header before retrying a 429. Example code is attached. Longer term, subscribing to `policy.updated` webhooks would let you skip most of the morning re-check, since you'd hear about cancellations as they happen.

## Internal note

- Request to raise the limit declined; root cause was the access pattern. Customer agreed.
- Worth a docs example of a paced batch job; batch jobs cause most 429 tickets.

## Prevent it next time

- **Docs:** "Running batch jobs" page with this pacing example.
- **Product:** suggest webhooks in the 429 response's docs link for customers who poll daily.
- **Detection:** `rate_limit_burst` reports the peak second and retries that ignored `Retry-After`.
