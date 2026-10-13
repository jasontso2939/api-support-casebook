---
id: TCK-1043
title: The 9 a.m. re-check job fails for hundreds of renters
severity: Sev 2
area: Rate limits
opened: Tue Oct 6, 09:12 PT
resolved: Tue Oct 6, 15:40 PT
pattern: Burst traffic over the rate limit, retries ignoring Retry-After
---

## Report

> Every morning our job that re-checks insurance for the day's pickups fails for a big chunk of renters with 429 errors. We're on the plan with 100 requests per second and we only check about 300 policies, so we shouldn't be anywhere near the limit. Can you raise it?
>
> Dana, Contoso Rentals backend lead

## First response

> Hi Dana, thanks for the clear report. Before we talk limits, I want to look at how the requests arrive, because 300 checks can still trip a per-second limit if they all land at once. I'll pull this morning's job traffic and send you what I see by midday.

## Scope

Severity 2: a daily job fails for about half its renters, so front-desk staff check them by hand. Not an outage, and nothing else is affected.

## Investigation

1. **Look at volume per second, not per day.** The whole job hit Northwind inside one second: a peak of {{b.peak_per_second}} requests against a limit of 100.
2. **Count the 429s.** {{b.rate_limited}} of {{b.requests}} requests were rate limited.
3. **Check the retries.** Each limited request was retried immediately, twice, without waiting for the `Retry-After` header, so the retries were limited too. That's why the failures stuck.
4. **The limit isn't the problem.** 300 checks at 80 per second takes under 4 seconds. The job just needs to pace itself.

{{logs}}

{{triage}}

## Root cause

The job started every check at once (`Promise.all` over all policies) and retried 429s instantly. It used about 300 requests' worth of the limit in a few milliseconds, then spent its retries inside the same second.

## Fix

Pace the job under the limit with a small token bucket and a worker pool, and let the API client honor `Retry-After` as a backstop.

{{diff}}

## Verified

Same 300 renters with the fix: failures went from {{b.failed}} to {{f.failed}}, rate-limited requests from {{b.rate_limited}} to {{f.rate_limited}}, and the job takes {{f.job_seconds}} seconds.

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
