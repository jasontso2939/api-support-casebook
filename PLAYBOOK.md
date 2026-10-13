# Support playbook

## How a ticket is worked

1. **Acknowledge.** Reply within minutes, even before you know anything. Say what you're checking and when you'll update next.
2. **Set severity from impact.** Sev 1: a core flow is down for all users. Sev 2: a major feature is broken, data may be wrong, or a workaround is painful. Sev 3: intermittent, or a reasonable workaround exists.
3. **Scope it.** One customer or every customer? One endpoint or all? Since when, and what changed then?
4. **Gather evidence.** Ask for request IDs (the `x-request-id` header) and exact times. Pull the logs for that client and window.
5. **Unblock first.** Get the customer working (roll back, swap keys, replay events) before chasing the root cause.
6. **Find the root cause and prove the fix.** Reproduce it, change one thing, and add a test that fails on the old code.
7. **Resolve or escalate.** If it's a Northwind defect, escalate to engineering with the reproduction, request IDs, and impact.
8. **Close twice.** Once with the customer in plain language. Once internally: what happened, the pattern, and what would stop the next ticket (docs, product change, or an automated check).

## Reading a log line

Every request has `request_id`, `ts`, `client_id`, `env`, `endpoint`, `status`, `error_code` and `latency_ms`. Before trusting the status, read the client ID and the environment: a sandbox key on production explains a 401 faster than anything else.

## What each error usually means

| Status | Code | Usual cause | First check |
| --- | --- | --- | --- |
| 401 | `invalid_client` | Wrong keys, or sandbox keys on production | The key prefix (`nw_test_` or `nw_live_`) against the base URL |
| 401 | `token_missing` / `token_invalid` | No `x-access-token`, or a token from another client | The header on the failing request |
| 403 | `policy_forbidden` | The token's account doesn't own that policy | Which account the token came from |
| 404 | `invalid_id` | A malformed ID (a policy number instead of `pol_...`) | The exact path in the request |
| 404 | `not_found` | A well-formed ID that doesn't exist | Was it ever returned to this client? |
| 400 | `code_reused` | The callback ran twice; the first exchange worked | Other exchanges with the same code fingerprint |
| 400 | `code_expired` | The code sat more than 10 minutes before exchange | Time between consent and exchange |
| 429 | `rate_limited` | A burst, usually a batch job | Requests per second at the peak, and whether retries waited for `Retry-After` |
| 5xx | | Northwind or carrier side | Other clients at the same time; escalate with request IDs |
| Webhook 401 | `endpoint_rejected` | The customer's signature check failed | Verifying over the raw body with the right secret |

## The triage tool

`npm run triage -- <northwind.jsonl> [--customer contoso.jsonl]` prints a per-endpoint summary, the errors, and findings for five known patterns: environment mismatch, duplicate code exchange, rate-limit bursts, rejected webhooks, and the app using a different policy than it requested. Each finding cites request IDs, so the reply to the customer can point at evidence.
