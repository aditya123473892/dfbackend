const fs = require('fs');
const path = require('path');
const { EJSON } = require('bson');
const { MongoClient } = require('mongodb');

const rootDir = path.resolve(__dirname, '..');
const envPath = path.join(rootDir, '.env');
const dumpDir = path.join(rootDir, 'mongo_DF');

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

async function importDump() {
  loadEnv(envPath);

  const databaseUrl = process.env.DATABASE_URL;
  const databaseName = process.env.DATABASE_NAME || 'darkfantasy';

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is missing. Add it to .env before importing.');
  }

  const files = fs
    .readdirSync(dumpDir)
    .filter((file) => file.endsWith('.json'))
    .sort();

  const client = new MongoClient(databaseUrl);
  await client.connect();

  try {
    const db = client.db(databaseName);

    for (const file of files) {
      const match = file.match(/^(.+)\.([^.]+)\.json$/);
      if (!match) continue;

      const collectionName = match[2];
      const filePath = path.join(dumpDir, file);
      const content = fs.readFileSync(filePath, 'utf8').trim();
      const documents = content ? EJSON.parse(content) : [];

      if (!Array.isArray(documents)) {
        throw new Error(`${file} must contain a JSON array.`);
      }

      const collection = db.collection(collectionName);
      await collection.deleteMany({});

      if (documents.length > 0) {
        await collection.insertMany(documents, { ordered: false });
      }

      console.log(`${collectionName}: imported ${documents.length}`);
    }
  } finally {
    await client.close();
  }
}

importDump().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
