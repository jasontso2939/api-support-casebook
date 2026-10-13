// Finishing the Northwind consent flow on Contoso's side.
import type { Client } from './northwind.ts';

export interface ConnectStore {
  tokens: Map<string, { accessToken: string; accountId: string; policyIds: string[] }>;   // by connect session
  inflight: Map<string, Promise<ConnectResult>>;                                          // by authorization code
}
export interface ConnectResult { ok: boolean; message: string; requestId: string | null; errorCode?: string }

export const newConnectStore = (): ConnectStore => ({ tokens: new Map(), inflight: new Map() });

/**
 * Called by the consent callback page. The page can fire twice (a reload, a second tab,
 * a framework re-render), so this is idempotent. Fix for TCK-1042:
 *  - a session that already has a token is simply "connected";
 *  - two calls with the same code share one exchange instead of racing.
 */
export async function completeConnect(client: Client, store: ConnectStore, sessionId: string, code: string): Promise<ConnectResult> {
  if (store.tokens.has(sessionId)) return { ok: true, message: 'Insurance connected.', requestId: null };
  const pending = store.inflight.get(code);
  if (pending) return pending;
  const p = (async (): Promise<ConnectResult> => {
    const r = await client.request('POST', '/v1/token', { code });
    if (r.status === 200) {
      store.tokens.set(sessionId, { accessToken: r.data.access_token, accountId: r.data.account_id, policyIds: r.data.policy_ids });
      return { ok: true, message: 'Insurance connected.', requestId: r.requestId };
    }
    if (r.data?.error?.code === 'code_reused' && store.tokens.has(sessionId)) {
      return { ok: true, message: 'Insurance connected.', requestId: r.requestId };
    }
    return { ok: false, message: "We couldn't connect your insurance. Please try again.", requestId: r.requestId, errorCode: r.data?.error?.code };
  })();
  store.inflight.set(code, p);
  try { return await p; } finally { setTimeout(() => store.inflight.delete(code), 60_000).unref?.(); }
}
