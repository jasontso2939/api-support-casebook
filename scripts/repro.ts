// Run one ticket's scenario and write its logs: node scripts/repro.ts TCK-1044 [buggy|fixed]
import { mkdirSync, writeFileSync } from 'node:fs';
import { SCENARIOS } from './scenarios.ts';
import type { Variant } from './scenarios.ts';

const [ticket, variant = 'buggy'] = process.argv.slice(2);
if (!ticket || !SCENARIOS[ticket]) { console.error(`usage: node scripts/repro.ts <${Object.keys(SCENARIOS).join('|')}> [buggy|fixed]`); process.exit(2); }
const r = await SCENARIOS[ticket](variant as Variant);
const dir = `runs/${ticket}/${variant}`;
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/northwind.jsonl`, r.provider.map(l => JSON.stringify(l)).join('\n') + '\n');
writeFileSync(`${dir}/contoso.jsonl`, r.customer.map(l => JSON.stringify(l)).join('\n') + '\n');
writeFileSync(`${dir}/metrics.json`, JSON.stringify(r.metrics, null, 2) + '\n');
console.log(`${ticket} (${variant}): ${JSON.stringify(r.metrics)}`);
console.log(`logs: ${dir}/northwind.jsonl, ${dir}/contoso.jsonl`);
