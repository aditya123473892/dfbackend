import { Logger } from '@nestjs/common';
import { Connection } from 'mongoose';
export async function blockIndexes(
  db: Connection,
  apply = false,
  report = console.log,
) {
  const rows = db.db.collection('UserBlocks');
  const duplicates = await rows
    .aggregate([
      {
        $group: {
          _id: { blockerId: '$blockerId', blockedId: '$blockedId' },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
    ])
    .toArray();
  report(JSON.stringify({ collection: 'UserBlocks', apply, duplicates }));
  if (!apply) return duplicates;
  if (duplicates.length)
    throw new Error(
      'UserBlocks has duplicate pairs; resolve before applying indexes',
    );
  await rows.createIndex(
    { blockerId: 1, blockedId: 1 },
    { unique: true, name: 'block_pair_unique' },
  );
  await rows.createIndex({ blockedId: 1 }, { name: 'blocked_user' });
  await rows.createIndex({ blockerId: 1, _id: -1 }, { name: 'block_page' });
  return duplicates;
}

export const BLOCK_INDEX_NAMES = ['block_pair_unique', 'blocked_user', 'block_page'];

/** Startup check when indexes are operator-managed: never creates, only warns. */
export async function warnMissingBlockIndexes(
  db: Connection,
  warn = (message: string) => Logger.warn(message, 'BlockService'),
) {
  try {
    const names = new Set(
      (await db.db.collection('UserBlocks').listIndexes().toArray()).map(
        (index) => index.name,
      ),
    );
    const missing = BLOCK_INDEX_NAMES.filter((name) => !names.has(name));
    if (missing.length)
      warn(
        `UserBlocks indexes missing (${missing.join(', ')}); every request scans the collection. Run scripts/user-block-indexes.ts --apply.`,
      );
  } catch (error: any) {
    // A collection that does not exist yet has no indexes and no rows to scan.
    if (error?.codeName !== 'NamespaceNotFound')
      warn(`Could not verify UserBlocks indexes: ${error?.message || error}`);
  }
}
