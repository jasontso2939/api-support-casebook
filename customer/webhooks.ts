// Receiving Northwind's signed policy webhooks.
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface WebhookInput { rawBody: string; parsedBody: unknown; signature: string | undefined; secret: string; nowSec: number }
export interface WebhookOutcome { status: 200 | 400 | 401; reason: string }

const TOLERANCE_S = 300;

/**
 * Fix for TCK-1044: verify the HMAC over the exact bytes Northwind sent. Re-serializing
 * parsed JSON changes spacing, so the signature never matches.
 */
export function handleWebhook(input: WebhookInput): WebhookOutcome {
  const parts = Object.fromEntries((input.signature ?? '').split(',').map(kv => kv.split('=') as [string, string]));
  const t = Number(parts.t), v1 = parts.v1;
  if (!t || !v1) return { status: 400, reason: 'missing signature' };
  if (Math.abs(input.nowSec - t) > TOLERANCE_S) return { status: 401, reason: 'timestamp outside tolerance' };
  const expected = createHmac('sha256', input.secret).update(`${t}.${input.rawBody}`).digest();
  const given = Buffer.from(v1, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { status: 401, reason: 'invalid signature' };
  return { status: 200, reason: 'ok' };
}
