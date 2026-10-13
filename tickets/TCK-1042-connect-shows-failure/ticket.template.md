---
id: TCK-1042
title: Renters see "couldn't connect" but their insurance is connected
severity: Sev 3
area: Consent flow
opened: Sat Oct 3, 13:40 PT
resolved: Mon Oct 5, 10:15 PT
pattern: One authorization code exchanged twice
---

## Report

> A handful of renters each day say they got "We couldn't connect your insurance" after logging in to their carrier. When support looks them up later, the insurance shows as connected. It's confusing people and some of them give up. Maybe 1 in 6 or so?
>
> Marcus, Contoso Rentals product manager

## First response

> Hi Marcus, thanks for the detail, the "connected later" part is a really useful clue. Could you send two or three session IDs from renters who saw the error? I'll trace their requests end to end and come back with what I find today.

## Scope

Severity 3: intermittent, a workaround exists (the connection actually worked), but it costs bookings. Only some renters, only on the callback step.

## Investigation

1. **Follow one affected session through the logs.** Its authorization code was exchanged twice, about {{b.median_gap_ms}} ms apart. The first exchange returned 200 with a token. The second returned 400 `code_reused`.
2. **So the connection worked.** The error the renter saw was the second response.
3. **Check whether it's a pattern.** Across the day, {{b.callback_fired_twice}} of {{b.users}} codes were exchanged twice, and every one of those renters saw the error. Every renter who exchanged once was fine.
4. **Why twice?** Codes are single-use by design. Contoso's callback page calls their backend on load and again when the page re-renders or is reloaded, and the backend exchanges the code on every call.

{{logs}}

{{triage}}

## Root cause

The callback handler wasn't idempotent. A second call with the same code got `code_reused`, and the handler reported that as a failure even though the first call had already stored a token.

## Fix

Share one exchange per code, and treat a session that already has a token as connected.

{{diff}}

## Verified

Same traffic with the fix: renters who saw the error went from {{b.shown_failure}} to {{f.shown_failure}}, all {{f.actually_connected}} renters connected, and Northwind received exactly one exchange per code.

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
