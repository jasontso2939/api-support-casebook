// Run the mock API on its own: node scripts/provider.ts [sandbox|production] [port]
import { startProvider } from '../provider/server.ts';
const env = (process.argv[2] ?? 'sandbox') as 'sandbox' | 'production';
const p = await startProvider({ env });
console.log(`Northwind ${env} API at ${p.url}`);
console.log(`client id ${p.credentials.clientId} · secret ${p.credentials.clientSecret}`);
process.on('SIGINT', async () => { await p.stop(); process.exit(0); });
