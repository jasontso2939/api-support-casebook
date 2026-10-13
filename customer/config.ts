// Contoso Rentals (fictional): configuration for its Northwind integration.
export type Env = 'sandbox' | 'production';
export interface Config { env: Env; baseUrl: string; clientId: string; clientSecret: string }

export class ConfigError extends Error {}

const keyEnv = (key: string, live: string, test: string): Env | null =>
  key.startsWith(live) ? 'production' : key.startsWith(test) ? 'sandbox' : null;

/**
 * Reads Northwind settings and refuses to start when they don't belong together.
 * Fix for TCK-1041: a sandbox key pointed at production now fails the deploy
 * instead of failing every verification in production.
 */
export function loadConfig(vars: Record<string, string | undefined>): Config {
  const need = (k: string) => {
    const v = vars[k];
    if (!v) throw new ConfigError(`${k} is not set.`);
    return v;
  };
  const env = need('NORTHWIND_ENV') as Env;
  if (env !== 'sandbox' && env !== 'production') throw new ConfigError(`NORTHWIND_ENV must be sandbox or production, not "${env}".`);
  const cfg: Config = { env, baseUrl: need('NORTHWIND_BASE_URL'), clientId: need('NORTHWIND_CLIENT_ID'), clientSecret: need('NORTHWIND_CLIENT_SECRET') };
  const idEnv = keyEnv(cfg.clientId, 'nw_live_', 'nw_test_');
  const secretEnv = keyEnv(cfg.clientSecret, 'sk_live_', 'sk_test_');
  if (idEnv !== env || secretEnv !== env) {
    throw new ConfigError(`Northwind keys don't match NORTHWIND_ENV=${env}: client ID is ${idEnv ?? 'unrecognized'}, secret is ${secretEnv ?? 'unrecognized'}. Check the deploy's environment variables.`);
  }
  return cfg;
}
