import { Connection } from 'mongoose';
import { phoneOtpIndexes } from '../auth/otp/otp-indexes';
import { storageIndexes } from '../photos/storage-indexes';
import { blockIndexes } from '../user-blocks/block-indexes';
import { reportIndexes } from '../reports/report-indexes';

export async function migrateIndexes(db: Connection) {
  // Do not print duplicate contents, contact details or storage object keys.
  const quiet = () => undefined;
  await phoneOtpIndexes(db, true, quiet);
  await storageIndexes(db, true, quiet);
  await blockIndexes(db, true, quiet);
  await reportIndexes(db, true, quiet);
}

export async function assertDeploymentIndexes(db: Connection) {
  const required: [string, Record<string, number>][] = [
    ['Users', { username: 1 }], ['Users', { phoneE164: 1 }],
    ['VaultPhotos', { owner: 1, id: 1 }], ['VaultPhotos', { owner: 1, slot: 1 }],
    ['PhotoUploads', { owner: 1, requestId: 1 }], ['PhotoUploads', { owner: 1, slot: 1 }],
    ['UserBlocks', { blockerId: 1, blockedId: 1 }],
  ];
  for (const [collection, key] of required) {
    const indexes = await db.db.collection(collection).listIndexes().toArray();
    if (!indexes.some(index => index.unique === true && JSON.stringify(index.key) === JSON.stringify(key)))
      throw new Error(`Required unique index missing in ${collection}; run npm run migrate:deploy before starting the API`);
  }
}
