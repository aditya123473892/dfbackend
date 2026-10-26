import 'reflect-metadata';
import * as dotenv from 'dotenv';
dotenv.config();
import { createConnection } from 'mongoose';
import { PhotosService } from '../src/photos/photos.service';
import { S3BucketService } from '../src/s3-bucket/s3-bucket.service';

async function main() {
  const apply = process.argv.includes('--apply');
  const db = await createConnection(process.env.DATABASE_URL, {
    dbName: process.env.DATABASE_NAME,
  }).asPromise();
  const photos = new PhotosService(db, new S3BucketService());
  try {
    await photos.onModuleInit();
    let found = 0,
      migrated = 0,
      failed = 0;
    for (const name of ['Users', 'Groups', 'Posts', 'Events', 'ChatMessages']) {
      const collection = db.db.collection(name);
      for await (const row of collection.find({})) {
        const owner = String(
          name === 'Users'
            ? row._id
            : name === 'Groups'
              ? row.admin
              : name === 'Posts'
                ? row.user
                : name === 'Events'
                  ? row.creator
                  : row.sender,
        );
        const ref = `${name === 'Users' ? 'avatar' : name === 'Groups' ? 'group' : name === 'Posts' ? 'post' : name === 'Events' ? 'event' : 'chat'}:${row._id}`;
        const entries =
          name === 'Users'
            ? [row.avatar]
            : name === 'Groups'
              ? [row.groupIcon]
              : name === 'Events'
                ? [row.cover]
                : row.media || [];
        for (let index = 0; index < entries.length; index++) {
          const old = entries[index];
          if (!old) continue;
          const reference =
            typeof old === 'string'
              ? old
              : old.storageKey || old.filename || old.url;
          if (!reference) {
            failed++;
            continue;
          }
          found++;
          if (!apply) continue;
          try {
            const key = await photos.importLegacy(owner, reference, ref);
            const path =
              name === 'Users'
                ? 'avatar'
                : name === 'Groups'
                  ? 'groupIcon'
                  : name === 'Events'
                    ? 'cover'
                    : `media.${index}`;
            const value =
              typeof old === 'string'
                ? key
                : {
                    ...old,
                    filename: key,
                    storageKey: key,
                    mimetype: 'image/jpeg',
                    url: undefined,
                  };
            const changed = await collection.updateOne(
              { _id: row._id, [path]: old },
              { $set: { [path]: value } },
            );
            if (!changed.matchedCount)
              throw new Error('Reference changed concurrently');
            // The deletion worker checks other live references before deleting a shared legacy key.
            if (reference !== key) await photos.enqueue([reference]);
            migrated++;
          } catch {
            failed++;
          } // Report counts only, never keys/URLs/credential-bearing errors.
        }
      }
    }
    console.log(JSON.stringify({ dryRun: !apply, found, migrated, failed }));
    if (failed) process.exitCode = 1;
  } finally {
    await db.close();
  }
}
main().catch(() => {
  console.error(
    'Photo migration failed; verify database, bucket and moderation permissions.',
  );
  process.exitCode = 1;
});
