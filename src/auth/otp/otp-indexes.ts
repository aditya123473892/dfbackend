import { Connection } from 'mongoose';
import { THROTTLE_COLLECTION } from './otp-throttle';

export const PHONE_INDEX = 'phone_e164_unique';
export const THROTTLE_TTL_INDEX = 'otp_throttle_ttl';

/**
 * Phone OTP migration. Additive only: existing users keep phoneE164/phoneVerifiedAt
 * unset (nullable), and the legacy phoneNumber field is not read or changed.
 */
export async function phoneOtpIndexes(db: Connection, apply = false, report = console.log) {
  const users = db.db.collection('Users');
  const duplicates = await users
    .aggregate([
      { $match: { phoneE164: { $type: 'string' } } },
      { $group: { _id: '$phoneE164', count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
    ])
    .toArray();
  const linked = await users.countDocuments({ phoneVerifiedAt: { $type: 'date' } });
  // Counts only; never print phone numbers.
  report(JSON.stringify({ collection: 'Users', apply, linkedPhones: linked, duplicatePhones: duplicates.length }));
  if (!apply) return duplicates.length;
  if (duplicates.length) throw new Error('Users has duplicate phoneE164 values; resolve before applying indexes');
  await users.createIndex(
    { phoneE164: 1 },
    {
      unique: true,
      name: PHONE_INDEX,
      // Only linked numbers are unique; users without a phone are unaffected.
      partialFilterExpression: { phoneE164: { $type: 'string' } },
    },
  );
  await db.db
    .collection(THROTTLE_COLLECTION)
    .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: THROTTLE_TTL_INDEX });
  return 0;
}
