# TCK-1041: Every insurance check fails with 401 after a deploy

**Sev 1** · Authentication · opened Thu Oct 1, 10:51 PT · resolved Thu Oct 1, 11:19 PT · pattern: Sandbox credentials deployed to production

Reproduce it: `npm run repro -- TCK-1041 buggy`, then `npm run triage -- runs/TCK-1041/buggy/northwind.jsonl`. Regression test: `test/regressions.test.ts`.

## Report

> Since about 10:45 every insurance check at checkout is failing and renters can't complete bookings. The only change on our side was a routine deploy (v2.8.0). Is Northwind down?
>
> Priya, Contoso Rentals on-call engineer

## First response, 4 minutes in

> Hi Priya, I'm on this now and treating it as urgent. Northwind's API is up for other customers, so I'm looking at your traffic specifically. Two quick things would help: the time v2.8.0 went out, and one request ID from a failed check (it's in the `x-request-id` response header). I'll update you within 15 minutes either way.

## Scope

Severity 1: a core flow is down for every renter. It's isolated to one customer: other clients are succeeding, and Contoso's own traffic was fine until 10:42 PT.

## Investigation

1. **Pull the customer's requests around the start time.** Every request after 10:42 PT returned 401 `invalid_client`. Before that, everything succeeded.
2. **Read the client ID column, not just the status.** The failing requests come from `nw_test_contoso`. That's a sandbox key, and it's calling the production API. The last success came from `nw_live_contoso` a few minutes before the deploy.
3. **Match it to the change.** Priya confirmed v2.8.0 went out at 10:42. A deploy that changes which key is sent is a configuration problem, not an outage.

| Time (PT) | Request ID | Client | Endpoint | Status | Error | ms |
| --- | --- | --- | --- | --- | --- | --- |
| 10:28:45.373 | `req_c036ad390925` | `nw_live_contoso` | GET /v1/policies/pol_jM7Ukw4aoH | 200 |  | 4 |
| 10:32:10.382 | `req_1280e782cc1e` | `nw_live_contoso` | GET /v1/policies/pol_sNmAhAUy4X | 200 |  | 8 |
| 10:35:35.386 | `req_3f456afe59cd` | `nw_live_contoso` | GET /v1/policies/pol_niCBhcVv7d | 200 |  | 3 |
| 10:42:00.001 | `req_f36760d77264` | `nw_test_contoso` | POST /v1/connect/sessions | 401 | invalid_client | 0 |
| 10:42:20.002 | `req_afcba415da98` | `nw_test_contoso` | GET /v1/policies/pol_YX5fVYrYwp | 401 | invalid_client | 0 |
| 10:42:40.003 | `req_45006c6304f0` | `nw_test_contoso` | GET /v1/policies/pol_KKdAo9V51d | 401 | invalid_client | 0 |
| 10:43:00.004 | `req_73ad2e781fd2` | `nw_test_contoso` | POST /v1/connect/sessions | 401 | invalid_client | 0 |
| 10:43:20.005 | `req_f622b0fe85ae` | `nw_test_contoso` | GET /v1/policies/pol_3Z6ZUpcrfJ | 401 | invalid_client | 0 |

Triage output on the same logs:

```text
Northwind triage · 78 requests, 0 webhook deliveries · 2026-10-01 16:58:00 to 2026-10-01 17:51:40 UTC

ENDPOINT                        REQS   2xx   4xx   5xx  p50 ms  p95 ms
GET /v1/policies/:id              32    12    20     0       0       9
POST /v1/connect/sessions         22    12    10     0       3       9
POST /v1/simulate/consent         12    12     0     0       6      10
POST /v1/token                    12    12     0     0       7       9

ERRORS
  401 invalid_client                 30

FINDINGS (1)
  [high] Sandbox credentials are calling production
    30 requests from client nw_test_contoso were rejected with 401 invalid_client on production, 100% of traffic since 2026-10-01T17:42:00.001Z. The last successful request came from nw_live_contoso at 2026-10-01T17:35:35.386Z, so the credentials changed between those two times.
    first seen 2026-10-01T17:42:00.001Z
    evidence: req_f36760d77264, req_afcba415da98, req_45006c6304f0
    next: Check the environment variables in the latest deploy. Sandbox keys (nw_test_) only work against the sandbox base URL.
```

## Root cause

The v2.8.0 deploy promoted the staging environment file, which holds the sandbox client ID and secret, while `NORTHWIND_ENV` and the base URL stayed on production. Contoso's config loader read the variables without checking that they belong together, so the app started and every call failed.

## Unblock first

Before any code change: put the live client ID and secret back in production and restart. Checkout recovered at 11:06 PT. The code fix came after.

## Fix

`loadConfig` now refuses to start when the key prefixes (`nw_live_` / `nw_test_`) don't match `NORTHWIND_ENV`. A bad deploy now fails its health check and never takes traffic.

```diff
--- tickets/TCK-1041-sudden-401s/buggy.ts (what shipped)
+++ customer/config.ts (fixed)
 export function loadConfig(vars: Record<string, string | undefined>): Config {
-  return {
-    env: (vars.NORTHWIND_ENV ?? 'sandbox') as Env,
-    baseUrl: vars.NORTHWIND_BASE_URL ?? '',
-    clientId: vars.NORTHWIND_CLIENT_ID ?? '',
-    clientSecret: vars.NORTHWIND_CLIENT_SECRET ?? '',
+  const need = (k: string) => {
+    const v = vars[k];
+    if (!v) throw new ConfigError(`${k} is not set.`);
+    return v;
   };
+  const env = need('NORTHWIND_ENV') as Env;
+  if (env !== 'sandbox' && env !== 'production') throw new ConfigError(`NORTHWIND_ENV must be sandbox or production, not "${env}".`);
+  const cfg: Config = { env, baseUrl: need('NORTHWIND_BASE_URL'), clientId: need('NORTHWIND_CLIENT_ID'), clientSecret: need('NORTHWIND_CLIENT_SECRET') };
+  const idEnv = keyEnv(cfg.clientId, 'nw_live_', 'nw_test_');
+  const secretEnv = keyEnv(cfg.clientSecret, 'sk_live_', 'sk_test_');
+  if (idEnv !== env || secretEnv !== env) {
+    throw new ConfigError(`Northwind keys don't match NORTHWIND_ENV=${env}: client ID is ${idEnv ?? 'unrecognized'}, secret is ${secretEnv ?? 'unrecognized'}. Check the deploy's environment variables.`);
+  }
+  return cfg;
 }
```

## Verified

Replaying the same deploy with the fix: the deploy stops at preflight with "Northwind keys don't match NORTHWIND_ENV=production: client ID is sandbox, secret is sandbox. Check the deploy's environment variables.", the previous version keeps serving, and 30 of 30 requests after the attempted deploy succeed (before the fix: 0 of 30).

## Reply to the customer

> Hi Priya, checkout has been working again since 11:06. Root cause: v2.8.0 shipped with your staging Northwind keys (`nw_test_...`) while the app was pointed at production, and sandbox keys can't authenticate there. Nothing changed or failed on Northwind's side.
>
> To keep this from happening again, I'd suggest a startup check that compares the key prefix to the environment. I've attached a short version you're welcome to drop in, along with the request IDs I traced if your team wants to cross-check.

## Internal note

- Customer impact: about 24 minutes of failed checkouts (10:42 to 11:06 PT), all renters, one customer.
- No Northwind defect. Second environment mix-up this quarter across customers, so it's a pattern worth fixing on our side too.

## Prevent it next time

- **Product:** the 401 message could say "This is a sandbox key. Production needs a key that starts with nw_live_." That turns a 30-minute ticket into a 2-minute fix. Filed to the API team.
- **Detection:** `env_mismatch` in the triage tool flags any test key on production automatically.
