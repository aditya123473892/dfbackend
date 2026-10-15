/**
 * Optional data clean-up. ChatMessages (sender, receiver, groupId) and Groups
 * (admin, members) hold ids as plain strings when written by earlier backend
 * versions, and as ObjectIds when imported from a dump. The API matches both
 * forms, so this is not required for correctness; it converts strings to
 * ObjectIds so the data has one representation.
 *
 * Usage: npm run db:normalize-chat-ids -- [--dry-run]
 */
const fs = require('fs');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');

const dryRun = process.argv.includes('--dry-run');
const HEX_ID = /^[a-f\d]{24}$/i;

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    if (!process.env[key]) process.env[key] = trimmed.slice(separatorIndex + 1).trim();
  }
}

const toId = (value) => (typeof value === 'string' && HEX_ID.test(value) ? new ObjectId(value) : value);

async function normalize(db) {
  const messages = db.collection('ChatMessages');
  let changedMessages = 0;
  const messageFilter = {
    $or: ['sender', 'receiver', 'groupId'].map((field) => ({ [field]: { $type: 'string' } })),
  };
  for await (const message of messages.find(messageFilter).project({ sender: 1, receiver: 1, groupId: 1 })) {
    const update = {};
    for (const field of ['sender', 'receiver', 'groupId']) {
      if (typeof message[field] === 'string') update[field] = toId(message[field]);
    }
    changedMessages++;
    if (!dryRun) await messages.updateOne({ _id: message._id }, { $set: update });
  }

  const groups = db.collection('Groups');
  let changedGroups = 0;
  for await (const group of groups.find({}).project({ admin: 1, members: 1 })) {
    const members = (group.members || []).map(toId);
    const unique = [...new Map(members.map((id) => [String(id), id])).values()];
    const admin = toId(group.admin);
    const changed = admin !== group.admin || unique.length !== (group.members || []).length ||
      members.some((id, index) => id !== group.members[index]);
    if (!changed) continue;
    changedGroups++;
    if (!dryRun) await groups.updateOne({ _id: group._id }, { $set: { admin, members: unique } });
  }
  console.log(`Messages with string ids: ${changedMessages}; groups with string or duplicate ids: ${changedGroups}`);
}

async function main() {
  loadEnv(path.join(path.resolve(__dirname, '..'), '.env'));
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is missing. Add it to .env first.');
  const client = new MongoClient(process.env.DATABASE_URL);
  try {
    await client.connect();
    await normalize(client.db(process.env.DATABASE_NAME || 'darkfantasy'));
    console.log(dryRun ? 'Dry run: nothing was changed.' : 'Normalization complete.');
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

module.exports = { normalize };
