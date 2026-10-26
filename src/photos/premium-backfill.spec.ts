import { Types } from 'mongoose';
import sharp = require('sharp');
import { backfillPremium } from './premium-backfill';

describe('Premium backfill', () => {
  const owner = '507f1f77bcf86cd799439011';
  const postId = '507f1f77bcf86cd799439012';
  const key = `posts/${owner}/${postId}/original.jpg`;
  function harness() {
    const post: any = { _id: new Types.ObjectId(postId), user: new Types.ObjectId(owner), media: [{ filename: key }] };
    const photo: any = { _id: 'upload-id', owner, key, ref: `post:${postId}`, state: 'attached', contentType: 'image/jpeg' };
    const set = (target: any, patch: any) => { for (const [path, value] of Object.entries(patch.$set)) {
      const segments = path.split('.'); let parent = target;
      for (const part of segments.slice(0, -1)) parent = parent[part];
      parent[segments[segments.length - 1]] = value;
    } };
    const posts = {
      find: (filter: any) => ({ sort: () => ({ limit: () => ({ toArray: async () => filter._id ? [] : [post] }) }) }),
      updateOne: jest.fn(async (_filter: any, update: any) => { set(post, update); return { matchedCount: 1 }; }),
    };
    const uploads = { findOne: jest.fn(async () => photo), updateOne: jest.fn(async (_filter: any, update: any) => {
      if (_filter.previewProcessingKey && photo.previewProcessingKey) return { matchedCount: 0 };
      set(photo, update); return { matchedCount: 1 };
    }) };
    return { post, photo, posts, uploads, db: { db: { collection: (name: string) => name === 'Posts' ? posts : uploads } } as any };
  }
  it('dry-runs without any writes; apply is batched/idempotent and preserves original keys', async () => {
    const h = harness();
    const storage: any = { keyFromReference: (value: string) => value,
      readVerified: jest.fn(async () => sharp({ create: { width: 64, height: 32, channels: 3, background: 'red' } }).jpeg().toBuffer()),
      putPreview: jest.fn(), putApproved: jest.fn(), copyPrivate: jest.fn(), deleteOne: jest.fn() };
    const dry = await backfillPremium(h.db, storage, { apply: false, batchSize: 1 });
    expect(dry).toMatchObject({ posts: 1, defaulted: 1, images: 1, generated: 0 });
    expect(h.posts.updateOne).not.toHaveBeenCalled(); expect(h.uploads.updateOne).not.toHaveBeenCalled();
    expect(storage.readVerified).not.toHaveBeenCalled();
    const first = await backfillPremium(h.db, storage, { apply: true, batchSize: 1 });
    expect(first.generated).toBe(1);
    expect(h.post.contentVisibility).toBe('normal');
    expect(h.post.media[0].previewKey).toMatch(/^previews\//);
    expect(h.post.media[0].filename).toBe(key); expect(h.photo.key).toBe(key);
    const second = await backfillPremium(h.db, storage, { apply: true, batchSize: 1 });
    expect(second).toMatchObject({ generated: 0, alreadyComplete: 1, defaulted: 0 });
    expect(storage.putPreview).toHaveBeenCalledTimes(1);
    for (const method of ['putApproved', 'copyPrivate', 'deleteOne']) expect(storage[method]).not.toHaveBeenCalled();
  });
  it('skips a photo bound to a different author', async () => {
    const h = harness(); h.photo.owner = '507f1f77bcf86cd799439099';
    const storage: any = { keyFromReference: (value: string) => value, readVerified: jest.fn() };
    expect((await backfillPremium(h.db, storage, { apply: true, batchSize: 50 })).skipped).toBe(1);
    expect(storage.readVerified).not.toHaveBeenCalled();
  });
});
