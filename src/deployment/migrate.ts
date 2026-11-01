import 'dotenv/config';
import { createConnection, Schema } from 'mongoose';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { migrateIndexes, assertDeploymentIndexes } from './indexes';

async function main() {
  if (!process.env.DATABASE_URL || !process.env.DATABASE_NAME) throw new Error('DATABASE_URL and DATABASE_NAME are required');
  const db = await createConnection(process.env.DATABASE_URL, {
    dbName: process.env.DATABASE_NAME, autoIndex: false, serverSelectionTimeoutMS: 10000,
  }).asPromise();
  try {
    const hello = await db.db.admin().command({ hello: 1 });
    if (!hello.setName && hello.msg !== 'isdbgrid') throw new Error('MongoDB must be a replica set or sharded cluster');
    const directory = join(__dirname, '../common/schemas');
    for (const file of readdirSync(directory).filter(name => name.endsWith('.schema.js'))) {
      const exports = require(join(directory, file));
      for (const [name, schema] of Object.entries(exports)) {
        if (schema instanceof Schema && schema.get('autoIndex') !== false && name.endsWith('Schema') && schema.indexes().length)
          await db.model(name.slice(0, -6), schema).createIndexes();
      }
    }
    await migrateIndexes(db);
    await assertDeploymentIndexes(db);
    console.log('Deployment indexes are ready. Existing data was not deleted.');
  } finally { await db.close(); }
}
main().catch(error => {
  console.error(`Index migration failed (${error?.code || error?.name || 'Error'}). Check database connectivity, privileges and duplicate records; no automatic data cleanup is performed.`);
  process.exitCode = 1;
});
