// What Contoso shipped in v2.8.0: config read straight from the environment, no checks.
import type { Config, Env } from '../../customer/config.ts';

export function loadConfig(vars: Record<string, string | undefined>): Config {
  return {
    env: (vars.NORTHWIND_ENV ?? 'sandbox') as Env,
    baseUrl: vars.NORTHWIND_BASE_URL ?? '',
    clientId: vars.NORTHWIND_CLIENT_ID ?? '',
    clientSecret: vars.NORTHWIND_CLIENT_SECRET ?? '',
  };
}
