import * as path from 'path';
import * as dotenv from 'dotenv';
import { createConnection } from 'mongoose';
import { recoverPreservationGate } from '../src/reports/preservation';
dotenv.config({ path: path.join(__dirname, `../.env.${process.env.NODE_ENV || 'development'}`) });
dotenv.config({ path: path.join(__dirname, '../.env') });
async function main() {
  const token = process.argv.find((arg) => arg.startsWith('--token='))?.slice(8);
  if (!token || !process.argv.includes('--holder-stopped'))
    throw new Error('Stop the holder and settle storage requests first; requires --holder-stopped --token=<observed-token>');
  const db = await createConnection(process.env.DATABASE_URL, { dbName: process.env.DATABASE_NAME }).asPromise();
  try { await recoverPreservationGate(db, token); console.log('Expired report gate recovered'); }
  finally { await db.close(); }
}
void main().catch(() => { console.error('Report gate recovery denied or failed; inspect the lease privately and retry only after stopping its holder'); process.exitCode = 1; });
