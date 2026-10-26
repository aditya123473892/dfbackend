import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { createConnection, Types } from 'mongoose';
import { assertLocalEntitlementDevelopment } from '../src/entitlements/dev-entitlement';
dotenv.config();

async function main() {
  // Runs BEFORE connecting. No environment flag can enable this in production.
  assertLocalEntitlementDevelopment(process.env);
  const [userId, duration = '15'] = process.argv.slice(2);
  const minutes = Number(duration);
  if (!Types.ObjectId.isValid(userId || '') || !Number.isInteger(minutes) || minutes < 0 || minutes > 1440)
    throw new Error('Usage: set-test-premium <userId> <minutes: 0..1440>; 0 clears entitlement');
  const db = await createConnection(process.env.DATABASE_URL, { dbName: process.env.DATABASE_NAME }).asPromise();
  try {
    const result = await db.db.collection('Users').updateOne({ _id: new Types.ObjectId(userId) },
      { $set: { premiumUntil: minutes ? new Date(Date.now() + minutes * 60000) : null } });
    if (!result.matchedCount) throw new Error('Test user not found');
    console.log('Local test entitlement updated; refresh the app.');
  } finally { await db.close(); }
}
main().catch(() => { console.error('Test entitlement update failed. Verify the local development configuration and arguments.'); process.exitCode = 1; });
