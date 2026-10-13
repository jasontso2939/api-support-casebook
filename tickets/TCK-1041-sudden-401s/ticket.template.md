---
id: TCK-1041
title: Every insurance check fails with 401 after a deploy
severity: Sev 1
area: Authentication
opened: Thu Oct 1, 10:51 PT
resolved: Thu Oct 1, 11:19 PT
pattern: Sandbox credentials deployed to production
---

## Report

> Since about 10:45 every insurance check at checkout is failing and renters can't complete bookings. The only change on our side was a routine deploy (v2.8.0). Is Northwind down?
>
> Priya, Contoso Rentals on-call engineer

## First response, 4 minutes in

> Hi Priya, I'm on this now and treating it as urgent. Northwind's API is up for other customers, so I'm looking at your traffic specifically. Two quick things would help: the time v2.8.0 went out, and one request ID from a failed check (it's in the `x-request-id` response header). I'll update you within 15 minutes either way.

## Scope

Severity 1: a core flow is down for every renter. It's isolated to one customer: other clients are succeeding, and Contoso's own traffic was fine until {{b.first_seen}}.

## Investigation

1. **Pull the customer's requests around the start time.** Every request after 10:42 PT returned 401 `invalid_client`. Before that, everything succeeded.
2. **Read the client ID column, not just the status.** The failing requests come from `nw_test_contoso`. That's a sandbox key, and it's calling the production API. The last success came from `nw_live_contoso` a few minutes before the deploy.
3. **Match it to the change.** Priya confirmed v2.8.0 went out at 10:42. A deploy that changes which key is sent is a configuration problem, not an outage.

{{logs}}

Triage output on the same logs:

{{triage}}

## Root cause

The v2.8.0 deploy promoted the staging environment file, which holds the sandbox client ID and secret, while `NORTHWIND_ENV` and the base URL stayed on production. Contoso's config loader read the variables without checking that they belong together, so the app started and every call failed.

## Unblock first

Before any code change: put the live client ID and secret back in production and restart. Checkout recovered at 11:06 PT. The code fix came after.

## Fix

`loadConfig` now refuses to start when the key prefixes (`nw_live_` / `nw_test_`) don't match `NORTHWIND_ENV`. A bad deploy now fails its health check and never takes traffic.

{{diff}}

## Verified

Replaying the same deploy with the fix: the deploy stops at preflight with "{{f.config_error}}", the previous version keeps serving, and {{f.after_deploy_ok}} of {{f.after_deploy_requests}} requests after the attempted deploy succeed (before the fix: {{b.after_deploy_ok}} of {{b.after_deploy_requests}}).

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
