import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { createConnection } from 'mongoose';
import { backfillPremium } from '../src/photos/premium-backfill';
import { S3BucketService } from '../src/s3-bucket/s3-bucket.service';
dotenv.config();

async function main() {
  const args = process.argv.slice(2);
  const value = (flag: string) => args[args.indexOf(flag) + 1];
  const db = await createConnection(process.env.DATABASE_URL, { dbName: process.env.DATABASE_NAME }).asPromise();
  try {
    const report = await backfillPremium(db, new S3BucketService(), {
      apply: args.includes('--apply'), batchSize: args.includes('--batch-size') ? Number(value('--batch-size')) : 50,
      after: args.includes('--after') ? value('--after') : undefined,
    });
    console.log(JSON.stringify({ mode: args.includes('--apply') ? 'apply' : 'dry-run', ...report }));
    if (report.failed) process.exitCode = 1;
  } finally { await db.close(); }
}
main().catch(() => { console.error('Premium backfill failed; check configuration and migration arguments.'); process.exitCode = 1; });
