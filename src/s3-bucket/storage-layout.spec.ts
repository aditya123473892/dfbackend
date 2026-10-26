import { randomUUID } from 'crypto';
import { allocateKey, buildKey, bucketForKey, storedKey, ResourceType } from './storage-layout';

describe('Backend storage layout', () => {
  const context = { ownerId: '507f1f77bcf86cd799439011', resourceId: '507f1f77bcf86cd799439012', conversationId: 'server-conversation', messageId: 'server-message' };
  it.each([
    ['profile', /^profile\/[^/]+\/[0-9a-f-]+\/original.jpg$/],
    ['post', /^posts\/[^/]+\/[^/]+\/[0-9a-f-]+\/original.jpg$/],
    ['event', /^events\/[^/]+\/cover\/[0-9a-f-]+\/original.jpg$/],
    ['group', /^groups\/[^/]+\/icon\/[0-9a-f-]+\/original.jpg$/],
    ['vault', /^vault\/[^/]+\/[0-9a-f-]+.jpg$/],
    ['chat', /^chat\/server-conversation\/server-message\/[0-9a-f-]+.jpg$/],
    ['temp', /^temp\/[^/]+\/[0-9a-f-]+.jpg$/],
  ])('allocates %s keys with a server UUID', (type, pattern) => {
    const binding = { ...context, resourceType: type as ResourceType };
    const allocated = allocateKey(binding);
    expect(allocated.key).toMatch(pattern);
    expect(buildKey(binding, allocated.objectId)).toBe(allocated.key);
    expect(allocateKey(binding).key).not.toBe(allocated.key);
  });
  it('reserves client variant names without generating any variants', () => {
    const binding = { ...context, resourceType: 'post' as const };
    const id = randomUUID();
    expect(buildKey(binding, id, 320)).toMatch(/\/320.webp$/);
    expect(buildKey(binding, id, 1080)).toMatch(/\/1080.webp$/);
    expect(() => buildKey(binding, '../filename')).toThrow();
    expect(() => buildKey({ ...binding, resourceId: '../client-path' }, id)).toThrow();
    expect(() => buildKey(binding, id, 999 as any)).toThrow();
  });
  it('selects split buckets by prefix, preserving the legacy bucket', () => {
    const previous = { ...process.env };
    try {
      delete process.env.PHOTO_MEDIA_BUCKET; delete process.env.PHOTO_PRIVATE_BUCKET;
      expect(bucketForKey('posts/server/key', 'same')).toBe('same');
      process.env.PHOTO_MEDIA_BUCKET = 'media'; process.env.PHOTO_PRIVATE_BUCKET = 'private';
      expect(bucketForKey('posts/server/key', 'same')).toBe('media');
      for (const prefix of ['vault', 'chat', 'temp', 'quarantine', 'reports']) expect(bucketForKey(prefix + '/key', 'same')).toBe('private');
      expect(bucketForKey('users/legacy/key', 'same')).toBe('same');
    } finally { process.env = previous; }
  });
  it.each(['legacy', 'canonical'])('reads both stored layouts in %s mode', mode => {
    const previous = process.env.STORAGE_LAYOUT_READ;
    try {
      process.env.STORAGE_LAYOUT_READ = mode;
      expect(storedKey({ key: 'users/legacy.jpg' })).toBe('users/legacy.jpg');
      expect(storedKey({ s3Key: 'posts/canonical.jpg' })).toBe('posts/canonical.jpg');
    } finally { if (previous === undefined) delete process.env.STORAGE_LAYOUT_READ; else process.env.STORAGE_LAYOUT_READ = previous; }
  });
});
