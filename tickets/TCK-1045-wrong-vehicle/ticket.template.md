---
id: TCK-1045
title: A renter's policy shows the wrong car
severity: Sev 2
area: Data accuracy
opened: Thu Oct 8, 15:25 PT
resolved: Fri Oct 9, 11:00 PT
pattern: Customer-side cache keyed by account instead of policy
---

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

{{logs}}

{{triage}}

## Root cause

Contoso's policy cache used the account ID as its key. For renters with more than one policy, the rental check got whichever policy had been cached first.

## Fix

Key the cache by account and policy ID.

{{diff}}

## Verified

Same renters with the fix: wrong-policy checks went from {{b.wrong_policy_used}} to {{f.wrong_policy_used}}, and wrongful declines from {{b.declined}} to {{f.declined}}.

## Reply to the customer

> Hi Marcus, I traced the declined bookings and the API returned the correct vehicle for every policy it was asked about. The catch is that it was never asked about the policy those renters booked with. All the affected renters have two cars on two separate policies, and your policy cache is keyed by account, so the rental check reused the first policy it had cached.
>
> Keying the cache by policy ID fixes it; the change is attached. Those renters should pass if you re-run their checks after the fix ships.

## Internal note

- Northwind data verified correct; no API defect. Closed with the customer's agreement.
- Every renter with two policies hit this ({{b.wrong_policy_used}} of {{b.rentals}} in the sample), so it would have kept recurring.

## Prevent it next time

- **Docs:** call out that one account can hold several policies, each with its own vehicles.
- **Detection:** with the customer's logs, `policy_mismatch` compares what was requested with what was used and shows whether the API ever saw the request.
