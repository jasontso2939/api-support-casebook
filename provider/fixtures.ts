// Deterministic fake insurance data. Every name, VIN and carrier here is fictional.
import { createHash } from 'node:crypto';

export interface Vehicle { vin: string; year: number; make: string; model: string }
export interface Coverage { code: 'BI' | 'PD' | 'COMP' | 'COLL'; per_person?: number; per_accident?: number; limit?: number; deductible?: number }
export interface Policy {
  id: string; account_id: string; carrier: string; status: 'active' | 'cancelled';
  insured: { first_name: string; last_name: string };
  vehicles: Vehicle[]; coverages: Coverage[]; effective_date: string; expiration_date: string;
}
export interface Account { id: string; policy_ids: string[] }

export const CARRIERS = ['Northstar Mutual', 'Pacific Shield', 'Summit Auto'];
const FIRST = ['Ana', 'Ben', 'Chloe', 'Dev', 'Elena', 'Femi', 'Grace', 'Hiro', 'Isla', 'Jonah', 'Kira', 'Luis'];
const LAST = ['Alvarez', 'Brooks', 'Chen', 'Diallo', 'Evans', 'Fischer', 'Gupta', 'Hayes', 'Ito', 'Jensen', 'Kowalski', 'Lopez'];
const CARS: [string, string][] = [['Toyota', 'Camry'], ['Honda', 'Civic'], ['Subaru', 'Outback'], ['Ford', 'F-150'], ['Tesla', 'Model 3'], ['Mazda', 'CX-5']];
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Small seeded PRNG so fixtures and IDs are reproducible from a string seed. */
export function rng(seed: string) {
  let h = createHash('sha256').update(seed).digest();
  let i = 0;
  return () => {
    if (i + 4 > h.length) { h = createHash('sha256').update(h).digest(); i = 0; }
    const v = h.readUInt32BE(i); i += 4;
    return v / 2 ** 32;
  };
}

export function id(prefix: string, r: () => number, len = 10) {
  let s = '';
  for (let k = 0; k < len; k++) s += B62[Math.floor(r() * 62)];
  return `${prefix}_${s}`;
}

function vin(r: () => number) {
  const chars = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789';
  let s = '';
  for (let k = 0; k < 17; k++) s += chars[Math.floor(r() * chars.length)];
  return s;
}

/** Builds one account with `count` policies (one vehicle each) for an end user. */
export function makeAccount(userRef: string, count = 1): { account: Account; policies: Policy[] } {
  const r = rng(`account:${userRef}:${count}`);
  const accountId = id('acc', r);
  const first = FIRST[Math.floor(r() * FIRST.length)], last = LAST[Math.floor(r() * LAST.length)];
  const carrier = CARRIERS[Math.floor(r() * CARRIERS.length)];
  const policies: Policy[] = [];
  for (let k = 0; k < count; k++) {
    const [make, model] = CARS[Math.floor(r() * CARS.length)];
    policies.push({
      id: id('pol', r), account_id: accountId, carrier, status: 'active',
      insured: { first_name: first, last_name: last },
      vehicles: [{ vin: vin(r), year: 2016 + Math.floor(r() * 9), make, model }],
      coverages: [
        { code: 'BI', per_person: 100000, per_accident: 300000 },
        { code: 'PD', limit: 100000 },
        { code: 'COLL', deductible: 500 },
      ],
      effective_date: '2026-03-01', expiration_date: '2027-03-01',
    });
  }
  return { account: { id: accountId, policy_ids: policies.map(p => p.id) }, policies };
}
