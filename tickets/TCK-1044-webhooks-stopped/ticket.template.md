---
id: TCK-1044
title: Policy webhooks stopped arriving
severity: Sev 2
area: Webhooks
opened: Wed Oct 7, 14:05 PT
resolved: Wed Oct 7, 16:30 PT
pattern: Signature checked against a re-serialized body
---

## Report

> We haven't received a single policy webhook since Tuesday. Cancellations aren't reaching us, which means we could hand keys to someone whose insurance lapsed. Did something change with your webhooks?
>
> Dana, Contoso Rentals backend lead

## First response

> Hi Dana, understood, missed cancellations are a real risk so this is my priority this afternoon. While I look at our delivery logs for your endpoint: did anything change in how your webhook endpoint is deployed or parses requests around Tuesday?

## Scope

Severity 2: no data loss on Northwind's side, but Contoso is blind to policy changes until it's fixed. In the meantime, the morning re-check job still catches cancellations once a day, which is the workaround.

## Investigation

1. **Are we sending?** Yes. Northwind attempted every event, three times each: {{b.delivery_attempts}} attempts for {{b.events}} events.
2. **What did the endpoint say?** HTTP 401 every time. The endpoint is reachable and answering; it's refusing.
3. **A 401 from a webhook endpoint is nearly always signature verification.** The two usual causes are the wrong secret, or verifying a body that isn't the exact bytes that were sent.
4. **Contoso's change.** Dana confirmed they upgraded their web framework Tuesday. The new version parses JSON bodies before the handler runs, and the handler re-serialized the parsed object to verify it. Northwind's bodies have a space after each comma and colon; re-serializing removes those spaces, so the HMAC can never match.

{{logs}}

{{triage}}

## Root cause

Signature verification ran over `JSON.stringify(parsedBody)` instead of the raw request body. Any change in spacing or key order changes the HMAC.

## Fix

Verify over the raw body exactly as received, compare in constant time, and reject timestamps older than five minutes to block replays.

{{diff}}

## Verified

With the fix, {{f.delivered}} of {{f.events}} events were delivered, each on the first attempt (before: {{b.delivered}} of {{b.events}}).

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
