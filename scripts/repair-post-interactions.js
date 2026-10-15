/**
 * One-off repair before deploying the unique (post, user) like index.
 *
 * - Removes duplicate Likes rows (keeps the oldest per post and user).
 * - Removes Likes and Comments whose post no longer exists.
 * - Rebuilds every post's `likes` and `comments` arrays from those collections,
 *   so counts match the stored records.
 *
 * Usage: npm run db:repair-post-interactions -- [--dry-run]
 * Reads DATABASE_URL and DATABASE_NAME from the environment or .env.
 */
const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

const rootDir = path.resolve(__dirname, '..');
const dryRun = process.argv.includes('--dry-run');

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;

  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

async function repair(db) {
  const likes = db.collection('Likes');
  const comments = db.collection('Comments');
  const posts = db.collection('Posts');

  const duplicates = await likes
    .aggregate([
      { $sort: { createdAt: 1, _id: 1 } },
      { $group: { _id: { post: '$post', user: '$user' }, ids: { $push: '$_id' }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
    ])
    .toArray();
  const duplicateIds = duplicates.flatMap((row) => row.ids.slice(1));
  console.log(`Duplicate likes to remove: ${duplicateIds.length}`);

  const postIds = await posts.distinct('_id');
  const orphanLikes = await likes.countDocuments({ post: { $nin: postIds } });
  const orphanComments = await comments.countDocuments({ post: { $nin: postIds } });
  console.log(`Likes on missing posts: ${orphanLikes}; comments on missing posts: ${orphanComments}`);

  if (dryRun) return;

  if (duplicateIds.length) await likes.deleteMany({ _id: { $in: duplicateIds } });
  await likes.deleteMany({ post: { $nin: postIds } });
  await comments.deleteMany({ post: { $nin: postIds } });

  let repaired = 0;
  for (const postId of postIds) {
    const [likeIds, commentIds] = await Promise.all([
      likes.distinct('_id', { post: postId }),
      comments.find({ post: postId }).sort({ createdAt: 1 }).project({ _id: 1 }).toArray(),
    ]);
    const result = await posts.updateOne(
      { _id: postId },
      { $set: { likes: likeIds, comments: commentIds.map((row) => row._id) } },
    );
    repaired += result.modifiedCount;
  }
  console.log(`Posts whose like/comment arrays were corrected: ${repaired}`);

  await likes.createIndex({ post: 1, user: 1 }, { unique: true });
  console.log('Unique (post, user) like index is in place.');
}

async function main() {
  loadEnv(path.join(rootDir, '.env'));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is missing. Add it to .env first.');

  const client = new MongoClient(databaseUrl);
  try {
    await client.connect();
    await repair(client.db(process.env.DATABASE_NAME || 'darkfantasy'));
    console.log(dryRun ? 'Dry run: nothing was changed.' : 'Repair complete.');
  } finally {
    await client.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}

module.exports = { repair };
