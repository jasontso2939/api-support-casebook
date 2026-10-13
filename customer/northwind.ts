// Contoso's Northwind API client.
import type { Config } from './config.ts';

export interface ApiResult<T = any> { status: number; data: T; requestId: string | null; retryAfter: number | null; attempts: number }
export interface ClientOptions { maxAttempts?: number; sleep?: (ms: number) => Promise<void>; random?: () => number }

const defaultSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export function createClient(cfg: Config, opts: ClientOptions = {}) {
  const maxAttempts = opts.maxAttempts ?? 4;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;

  async function once<T>(method: string, path: string, body?: unknown, token?: string): Promise<ApiResult<T>> {
    const headers: Record<string, string> = { 'x-client-id': cfg.clientId, 'x-client-secret': cfg.clientSecret };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers['x-access-token'] = token;
    const res = await fetch(cfg.baseUrl + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    const ra = res.headers.get('retry-after');
    return { status: res.status, data: text ? JSON.parse(text) : null, requestId: res.headers.get('x-request-id'), retryAfter: ra ? Number(ra) : null, attempts: 1 };
  }

  /** Retries 429 and 5xx, waiting at least as long as Retry-After asks, plus jitter. */
  async function request<T = any>(method: string, path: string, body?: unknown, token?: string): Promise<ApiResult<T>> {
    let last: ApiResult<T> | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      last = await once<T>(method, path, body, token);
      last.attempts = attempt;
      const retryable = last.status === 429 || last.status >= 500;
      if (!retryable || attempt === maxAttempts) return last;
      const base = last.retryAfter != null ? last.retryAfter * 1000 : 250 * 2 ** (attempt - 1);
      await sleep(base * (1 + random() * 0.25));
    }
    return last!;
  }

  return { request, once, config: cfg };
}
export type Client = ReturnType<typeof createClient>;
