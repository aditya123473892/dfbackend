import { Connection } from 'mongoose';

/** Archive duplicate legacy edges before enforcing uniqueness. Accepted wins. */
export async function socialIndexes(db: Connection) {
  // Imported posts may predate timestamp middleware. Do not overwrite known dates.
  await db.db.collection('Posts').updateMany({ createdAt: null, _id: { $type: 'objectId' } },
    [{ $set: { createdAt: { $toDate: '$_id' } } }]);
  const edges = db.db.collection('follows');
  const duplicates = edges.aggregate([
    { $group: { _id: { follower: '$follower', following: '$following' }, ids: { $push: '$_id' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]);
  for await (const group of duplicates) {
    const session = await db.startSession();
    try {
      await session.withTransaction(async () => {
        const rows = await edges.find({ _id: { $in: group.ids } }, { session }).toArray();
        rows.sort((a, b) => {
          const rank = (r: any) => r.status === 'accepted' ? 0 : r.status === 'pending' ? 1 : 2;
          return rank(a) - rank(b) || String(a._id).localeCompare(String(b._id));
        });
        for (const row of rows.slice(1)) {
          await db.db.collection('FollowDuplicateArchive').updateOne({ _id: row._id },
            { $setOnInsert: { ...row, archivedAt: new Date() } }, { upsert: true, session });
          await edges.deleteOne({ _id: row._id }, { session });
        }
      });
    } finally { await session.endSession(); }
  }
  await edges.createIndex({ follower: 1, following: 1 }, { unique: true });
  await edges.createIndex({ following: 1, status: 1, _id: -1 });
  await edges.createIndex({ follower: 1, status: 1, _id: -1 });
}
