// The webhook handler after Contoso's framework upgrade: the new body parser hands the
// handler parsed JSON, so the signature was computed over a re-serialized copy.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { WebhookInput, WebhookOutcome } from '../../customer/webhooks.ts';

export function handleWebhook(input: WebhookInput): WebhookOutcome {
  const parts = Object.fromEntries((input.signature ?? '').split(',').map(kv => kv.split('=') as [string, string]));
  const t = Number(parts.t), v1 = parts.v1;
  if (!t || !v1) return { status: 400, reason: 'missing signature' };
  const body = JSON.stringify(input.parsedBody);                    // not the bytes that were signed
  const expected = createHmac('sha256', input.secret).update(`${t}.${body}`).digest();
  const given = Buffer.from(v1, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { status: 401, reason: 'invalid signature' };
  return { status: 200, reason: 'ok' };
}
