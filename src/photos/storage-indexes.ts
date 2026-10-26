import { Connection } from 'mongoose';

/** No connection creation and no writes unless explicitly requested by the operator. */
export async function storageIndexes(db: Connection, apply = false, report = console.log) {
  const duplicates: Record<string, any[]> = {};
  for (const name of ['PhotoUploads', 'VaultPhotos']) {
    duplicates[name] = await db.db.collection(name).aggregate([
      { $match: { s3Key: { $type: 'string' } } },
      { $group: { _id: '$s3Key', count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
    ]).toArray();
  }
  // Operational reports must never log original storage keys.
  report(JSON.stringify({ duplicateGroups: Object.fromEntries(
    Object.entries(duplicates).map(([name, rows]) => [name, rows.length]),
  ), apply }));
  if (!apply) return duplicates;
  for (const name of ['PhotoUploads', 'VaultPhotos']) {
    const collection = db.db.collection(name);
    await collection.createIndex({ s3Key: 1 }, {
      name: duplicates[name].length ? 's3Key_unique_new_records' : 's3Key_unique',
      unique: true, background: true,
      partialFilterExpression: { s3Key: { $type: 'string' }, ...(duplicates[name].length ? { storageKeyUniqueEligible: true } : {}) },
    });
    await collection.createIndex({ ownerId: 1, resourceType: 1, resourceId: 1 }, { background: true });
    await collection.createIndex({ owner: 1, slot: 1 }, { unique: true, background: true });
    await collection.createIndex(name === 'PhotoUploads' ? { owner: 1, requestId: 1 } : { owner: 1, id: 1 }, { unique: true, background: true });
  }
  for (const [name, keys, options] of [
    ['PhotoRateLimits', { expiresAt: 1 }, { expireAfterSeconds: 0 }],
    ['PhotoDeletionJobs', { dueAt: 1 }, {}], ['AccountPurges', { dueAt: 1 }, {}],
    ['VaultTombstones', { owner: 1, id: 1 }, { unique: true }],
  ] as any[]) await db.db.collection(name).createIndex(keys, { background: true, ...options });
  return duplicates;
}
