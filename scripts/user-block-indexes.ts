import { createConnection } from 'mongoose';
import { blockIndexes } from '../src/user-blocks/block-indexes';

// Offline operator entry point: deploy/review these indexes BEFORE backend cutover.
async function main() {
  const option = process.argv[2] || '--report';
  if (!['--report', '--apply'].includes(option))
    throw new Error('Use --report or --apply');
  if (!process.env.DATABASE_URL || !process.env.DATABASE_NAME)
    throw new Error(
      'Set DATABASE_URL and DATABASE_NAME using your operator credential environment',
    );
  const db = await createConnection(process.env.DATABASE_URL, {
    dbName: process.env.DATABASE_NAME,
    autoIndex: false,
  }).asPromise();
  try {
    await blockIndexes(db, option === '--apply');
  } finally {
    await db.close();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
