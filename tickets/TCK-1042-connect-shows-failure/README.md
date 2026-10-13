# TCK-1042: Renters see "couldn't connect" but their insurance is connected

**Sev 3** · Consent flow · opened Sat Oct 3, 13:40 PT · resolved Mon Oct 5, 10:15 PT · pattern: One authorization code exchanged twice

Reproduce it: `npm run repro -- TCK-1042 buggy`, then `npm run triage -- runs/TCK-1042/buggy/northwind.jsonl`. Regression test: `test/regressions.test.ts`.

## Report

> A handful of renters each day say they got "We couldn't connect your insurance" after logging in to their carrier. When support looks them up later, the insurance shows as connected. It's confusing people and some of them give up. Maybe 1 in 6 or so?
>
> Marcus, Contoso Rentals product manager

## First response

> Hi Marcus, thanks for the detail, the "connected later" part is a really useful clue. Could you send two or three session IDs from renters who saw the error? I'll trace their requests end to end and come back with what I find today.

## Scope

Severity 3: intermittent, a workaround exists (the connection actually worked), but it costs bookings. Only some renters, only on the callback step.

## Investigation

1. **Follow one affected session through the logs.** Its authorization code was exchanged twice, about 16 ms apart. The first exchange returned 200 with a token. The second returned 400 `code_reused`.
2. **So the connection worked.** The error the renter saw was the second response.
3. **Check whether it's a pattern.** Across the day, 8 of 40 codes were exchanged twice, and every one of those renters saw the error. Every renter who exchanged once was fine.
4. **Why twice?** Codes are single-use by design. Contoso's callback page calls their backend on load and again when the page re-renders or is reloaded, and the backend exchanges the code on every call.

| Time (PT) | Request ID | Client | Endpoint | Status | Error | ms |
| --- | --- | --- | --- | --- | --- | --- |
| 12:05:00.023 | `req_472a1efb9456` | `nw_live_contoso` | POST /v1/token (code dd21427f) | 200 |  | 8 |
| 12:09:30.076 | `req_ec3f5741b693` | `nw_live_contoso` | POST /v1/token (code 9afb23f0) | 200 |  | 5 |
| 12:09:30.095 | `req_3ab2e2be8060` | `nw_live_contoso` | POST /v1/token (code 9afb23f0) | 400 | code_reused | 9 |
| 12:17:00.212 | `req_416aa6818bd9` | `nw_live_contoso` | POST /v1/token (code bf1a2aab) | 200 |  | 7 |
| 12:17:00.227 | `req_3c9fa2ed438e` | `nw_live_contoso` | POST /v1/token (code bf1a2aab) | 400 | code_reused | 6 |

```text
Northwind triage · 128 requests, 0 webhook deliveries · 2026-10-03 19:05:00 to 2026-10-03 20:03:30 UTC

ENDPOINT                        REQS   2xx   4xx   5xx  p50 ms  p95 ms
POST /v1/token                    48    40     8     0       6       9
POST /v1/connect/sessions         40    40     0     0       7       9
POST /v1/simulate/consent         40    40     0     0       5       9

ERRORS
  400 code_reused                     8

FINDINGS (1)
  [medium] The same authorization code is being exchanged twice
    8 of 40 codes were exchanged more than once. The first exchange succeeded and the repeat failed with code_reused, a median 16 ms later. The connection worked; whatever showed the user the second response showed an error.
    first seen 2026-10-03T19:09:30.076Z
    evidence: req_ec3f5741b693, req_3ab2e2be8060, req_416aa6818bd9, req_3c9fa2ed438e
    next: Make the callback idempotent: share one exchange per code, and treat code_reused as success when the session already has a token.
```

## Root cause

The callback handler wasn't idempotent. A second call with the same code got `code_reused`, and the handler reported that as a failure even though the first call had already stored a token.

## Fix

Share one exchange per code, and treat a session that already has a token as connected.

```diff
--- tickets/TCK-1042-connect-shows-failure/buggy.ts (what shipped)
+++ customer/connect.ts (fixed)
 export async function completeConnect(client: Client, store: ConnectStore, sessionId: string, code: string): Promise<ConnectResult> {
-  const r = await client.request('POST', '/v1/token', { code });
-  if (r.status === 200) {
-    store.tokens.set(sessionId, { accessToken: r.data.access_token, accountId: r.data.account_id, policyIds: r.data.policy_ids });
-    return { ok: true, message: 'Insurance connected.', requestId: r.requestId };
-  }
-  return { ok: false, message: "We couldn't connect your insurance. Please try again.", requestId: r.requestId, errorCode: r.data?.error?.code };
+  if (store.tokens.has(sessionId)) return { ok: true, message: 'Insurance connected.', requestId: null };
+  const pending = store.inflight.get(code);
+  if (pending) return pending;
+  const p = (async (): Promise<ConnectResult> => {
+    const r = await client.request('POST', '/v1/token', { code });
+    if (r.status === 200) {
+      store.tokens.set(sessionId, { accessToken: r.data.access_token, accountId: r.data.account_id, policyIds: r.data.policy_ids });
+      return { ok: true, message: 'Insurance connected.', requestId: r.requestId };
+    }
+    if (r.data?.error?.code === 'code_reused' && store.tokens.has(sessionId)) {
+      return { ok: true, message: 'Insurance connected.', requestId: r.requestId };
+    }
+    return { ok: false, message: "We couldn't connect your insurance. Please try again.", requestId: r.requestId, errorCode: r.data?.error?.code };
+  })();
+  store.inflight.set(code, p);
+  try { return await p; } finally { setTimeout(() => store.inflight.delete(code), 60_000).unref?.(); }
 }
```

## Verified

Same traffic with the fix: renters who saw the error went from 8 to 0, all 40 renters connected, and Northwind received exactly one exchange per code.

## Reply to the customer

> Hi Marcus, found it. Those renters did connect successfully. The callback page calls your backend twice in some browsers, and your backend exchanges the authorization code both times. Codes are single-use, so the second exchange is rejected and that rejection is what the renter sees.
>
> The fix is on your side and small: if a session already has a token, or an exchange for that code is already in progress, return that instead of exchanging again. I've attached a version that does both. Happy to look over your change if useful.

## Internal note

- Not a bug in the API: single-use codes are correct and documented.
- Our docs don't warn that callback pages often fire twice. Third customer to hit this.

## Prevent it next time

- **Docs:** add "make your callback idempotent" to the consent-flow guide, with this snippet.
- **Detection:** `duplicate_code_exchange` flags codes exchanged more than once, which can trigger a proactive note before the customer files a ticket.
