import { randomUUID } from 'crypto';
import { Connection, Types } from 'mongoose';
import { MediaService } from './media.service';
import { S3BucketService } from '../s3-bucket/s3-bucket.service';
import { matchesBinding, storedKey } from '../s3-bucket/storage-layout';

/** No original object is written, copied, renamed or deleted by this migration. */
export async function backfillPremium(db: Connection, storage: S3BucketService,
  options: { apply: boolean; batchSize: number; after?: string }) {
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 500)
    throw new Error('Batch size must be 1..500');
  if (options.after && !Types.ObjectId.isValid(options.after)) throw new Error('Invalid resume cursor');
  const posts = db.db.collection<any>('Posts');
  const uploads = db.db.collection<any>('PhotoUploads');
  const media = new MediaService(storage);
  const report = { posts: 0, defaulted: 0, images: 0, generated: 0, alreadyComplete: 0, skipped: 0, failed: 0, lastPostId: '' };
  let after = options.after ? new Types.ObjectId(options.after) : undefined;
  for (;;) {
    const batch = await posts.find(after ? { _id: { $gt: after } } : {}).sort({ _id: 1 }).limit(options.batchSize).toArray();
    if (!batch.length) break;
    for (const post of batch) {
      report.posts++;
      report.lastPostId = String(post._id);
      if (post.contentVisibility == null) {
        report.defaulted++;
        if (options.apply) await posts.updateOne({ _id: post._id, contentVisibility: null }, { $set: { contentVisibility: 'normal' } });
      }
      for (let index = 0; index < (post.media || []).length; index++) {
        report.images++;
        const image = post.media[index];
        const owner = String(post.user);
        const key = storage.keyFromReference(image.storageKey || image.s3Key || image.filename || image.url);
        if (!key || !Types.ObjectId.isValid(owner)) { report.skipped++; continue; }
        const photo = await uploads.findOne({ $or: [{ key }, { s3Key: key }], state: 'attached' });
        const context = { ownerId: owner, resourceType: 'post' as const, resourceId: String(post._id) };
        // Do not read an unbound legacy key or a different user's storage object.
        if (!photo || storedKey(photo) !== key || !matchesBinding(photo, context)) { report.skipped++; continue; }
        if (image.previewKey && image.blurhash && image.width && image.height) { report.alreadyComplete++; continue; }
        if (!options.apply) continue; // Dry-run performs no S3 reads/writes or DB writes.
        try {
          let metadata = { previewKey: photo.previewKey, blurhash: photo.blurhash, width: photo.width, height: photo.height };
          if (!metadata.previewKey || !metadata.blurhash || !metadata.width || !metadata.height) {
            // Reserve before writing so retries after a crash reuse exactly one key.
            const proposed = `previews/${owner}/${randomUUID()}.jpg`;
            await uploads.updateOne({ _id: photo._id, previewProcessingKey: { $exists: false } }, { $set: { previewProcessingKey: proposed } });
            const reserved = await uploads.findOne({ _id: photo._id });
            const previewKey = reserved.previewKey || reserved.previewProcessingKey;
            const bytes = await storage.readVerified(key, photo.contentType || image.mimetype || 'image/jpeg');
            metadata = await media.buildPreview(bytes, previewKey);
            await uploads.updateOne({ _id: photo._id }, { $set: metadata });
            report.generated++;
          }
          // Compare the exact array element so concurrent photo edits cannot get the wrong preview.
          const field = image.storageKey ? 'storageKey' : image.s3Key ? 's3Key' : image.filename ? 'filename' : 'url';
          const prefix = `media.${index}`;
          await posts.updateOne({ _id: post._id, [`${prefix}.${field}`]: image[field] }, { $set: {
            [`${prefix}.photoId`]: photo._id, ...Object.fromEntries(Object.entries(metadata).map(([name, value]) => [`${prefix}.${name}`, value])),
          } });
        } catch {
          // Never print SDK errors: they can include original keys or signed request data.
          report.failed++;
        }
      }
    }
    after = batch[batch.length - 1]._id;
  }
  return report;
}
