// The callback handler before the fix: every call exchanges the code again, and an
// error overwrites a success that already happened.
import type { Client } from '../../customer/northwind.ts';
import type { ConnectStore, ConnectResult } from '../../customer/connect.ts';

export async function completeConnect(client: Client, store: ConnectStore, sessionId: string, code: string): Promise<ConnectResult> {
  const r = await client.request('POST', '/v1/token', { code });
  if (r.status === 200) {
    store.tokens.set(sessionId, { accessToken: r.data.access_token, accountId: r.data.account_id, policyIds: r.data.policy_ids });
    return { ok: true, message: 'Insurance connected.', requestId: r.requestId };
  }
  return { ok: false, message: "We couldn't connect your insurance. Please try again.", requestId: r.requestId, errorCode: r.data?.error?.code };
}
