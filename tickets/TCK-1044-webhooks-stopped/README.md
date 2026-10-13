# TCK-1044: Policy webhooks stopped arriving

**Sev 2** · Webhooks · opened Wed Oct 7, 14:05 PT · resolved Wed Oct 7, 16:30 PT · pattern: Signature checked against a re-serialized body

Reproduce it: `npm run repro -- TCK-1044 buggy`, then `npm run triage -- runs/TCK-1044/buggy/northwind.jsonl`. Regression test: `test/regressions.test.ts`.

## Report

> We haven't received a single policy webhook since Tuesday. Cancellations aren't reaching us, which means we could hand keys to someone whose insurance lapsed. Did something change with your webhooks?
>
> Dana, Contoso Rentals backend lead

## First response

> Hi Dana, understood, missed cancellations are a real risk so this is my priority this afternoon. While I look at our delivery logs for your endpoint: did anything change in how your webhook endpoint is deployed or parses requests around Tuesday?

## Scope

Severity 2: no data loss on Northwind's side, but Contoso is blind to policy changes until it's fixed. In the meantime, the morning re-check job still catches cancellations once a day, which is the workaround.

## Investigation

1. **Are we sending?** Yes. Northwind attempted every event, three times each: 30 attempts for 10 events.
2. **What did the endpoint say?** HTTP 401 every time. The endpoint is reachable and answering; it's refusing.
3. **A 401 from a webhook endpoint is nearly always signature verification.** The two usual causes are the wrong secret, or verifying a body that isn't the exact bytes that were sent.
4. **Contoso's change.** Dana confirmed they upgraded their web framework Tuesday. The new version parses JSON bodies before the handler runs, and the handler re-serialized the parsed object to verify it. Northwind's bodies have a space after each comma and colon; re-serializing removes those spaces, so the HMAC can never match.

| Time (PT) | Request ID | Client | Endpoint | Status | Error | ms |
| --- | --- | --- | --- | --- | --- | --- |
| 11:00:00.206 | `evt_dlv_x2S7jaDS` | `nw_live_contoso` | webhook → /hooks/northwind (event evt_97Z4Nw6A9NyI, try 1) | 401 | endpoint_rejected | 3 |
| 11:00:00.232 | `evt_dlv_a7cHQdma` | `nw_live_contoso` | webhook → /hooks/northwind (event evt_97Z4Nw6A9NyI, try 2) | 401 | endpoint_rejected | 1 |
| 11:00:00.284 | `evt_dlv_ln15zHC0` | `nw_live_contoso` | webhook → /hooks/northwind (event evt_97Z4Nw6A9NyI, try 3) | 401 | endpoint_rejected | 1 |
| 11:17:00.367 | `evt_dlv_1kObT9Ud` | `nw_live_contoso` | webhook → /hooks/northwind (event evt_fmZA22xVZOSh, try 1) | 401 | endpoint_rejected | 1 |
| 11:17:00.394 | `evt_dlv_0pOOT4es` | `nw_live_contoso` | webhook → /hooks/northwind (event evt_fmZA22xVZOSh, try 2) | 401 | endpoint_rejected | 2 |
| 11:17:00.445 | `evt_dlv_3RcweLOQ` | `nw_live_contoso` | webhook → /hooks/northwind (event evt_fmZA22xVZOSh, try 3) | 401 | endpoint_rejected | 1 |

```text
Northwind triage · 41 requests, 30 webhook deliveries · 2026-10-07 15:00:00 to 2026-10-07 20:33:01 UTC

ENDPOINT                        REQS   2xx   4xx   5xx  p50 ms  p95 ms
POST /v1/connect/sessions         10    10     0     0       6       9
POST /v1/simulate/consent         10    10     0     0       4       8
POST /v1/token                    10    10     0     0       8       8
POST /v1/simulate/policy-event    10    10     0     0     161     167
POST /v1/webhooks                  1     1     0     0       3       3

ERRORS
  401 webhook: endpoint_rejected     30

FINDINGS (1)
  [high] The webhook endpoint /hooks/northwind is rejecting deliveries
    30 delivery attempts failed (HTTP 401); 10 of 10 events were never delivered after 3 attempts each. Northwind is sending; the endpoint is refusing. A 401 from a webhook endpoint almost always means signature verification failed: the wrong secret, or the body was parsed and re-serialized before verifying.
    first seen 2026-10-07T18:00:00.206Z
    evidence: evt_dlv_x2S7jaDS (event evt_97Z4Nw6A9NyI, attempt 1), evt_dlv_a7cHQdma (event evt_97Z4Nw6A9NyI, attempt 2), evt_dlv_ln15zHC0 (event evt_97Z4Nw6A9NyI, attempt 3)
    next: Verify the HMAC over the raw request body, exactly as received, with the endpoint secret from registration.
```

## Root cause

Signature verification ran over `JSON.stringify(parsedBody)` instead of the raw request body. Any change in spacing or key order changes the HMAC.

## Fix

Verify over the raw body exactly as received, compare in constant time, and reject timestamps older than five minutes to block replays.

```diff
--- tickets/TCK-1044-webhooks-stopped/buggy.ts (what shipped)
+++ customer/webhooks.ts (fixed)
 export function handleWebhook(input: WebhookInput): WebhookOutcome {
   const parts = Object.fromEntries((input.signature ?? '').split(',').map(kv => kv.split('=') as [string, string]));
   const t = Number(parts.t), v1 = parts.v1;
   if (!t || !v1) return { status: 400, reason: 'missing signature' };
-  const body = JSON.stringify(input.parsedBody);                    // not the bytes that were signed
-  const expected = createHmac('sha256', input.secret).update(`${t}.${body}`).digest();
+  if (Math.abs(input.nowSec - t) > TOLERANCE_S) return { status: 401, reason: 'timestamp outside tolerance' };
+  const expected = createHmac('sha256', input.secret).update(`${t}.${input.rawBody}`).digest();
   const given = Buffer.from(v1, 'hex');
   if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { status: 401, reason: 'invalid signature' };
   return { status: 200, reason: 'ok' };
 }
```

## Verified

With the fix, 10 of 10 events were delivered, each on the first attempt (before: 0 of 10).

## Reply to the customer

> Hi Dana, found it, and it lines up with Tuesday's framework upgrade. Northwind has been sending every webhook; your endpoint is rejecting them with 401 because the signature check now runs on the parsed-and-re-serialized JSON instead of the raw body. Re-serializing changes the spacing, so the signature never matches.
>
> Read the raw body before the JSON parser runs and verify that. I've attached a working version. Once it's deployed I can resend the events from Tuesday onward so you don't miss any cancellations.

## Internal note

- Offered a replay of events since Tuesday once the fix is live.
- Our webhook docs say "verify the raw body" but most framework examples parse first. A runnable example per framework would prevent this.

## Prevent it next time

- **Product:** auto-email the account contact after an endpoint fails for an hour, with the HTTP status. Contoso found out after a day.
- **Detection:** `webhook_rejected` flags endpoints rejecting deliveries and explains what a 401 usually means.
