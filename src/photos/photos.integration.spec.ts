import { createConnection, Connection, Types } from 'mongoose';
import { randomUUID } from 'crypto';
import { PhotosService } from './photos.service';
import { storageIndexes } from './storage-indexes';
import sharp = require('sharp');

// A real MongoDB is necessary to verify unique-index races, not a mocked counter.
// Tests always use their own randomly named database; never the application's DB.
const integration = process.env.TEST_MONGO_URI ? describe : describe.skip;
integration('Photo upload concurrency with MongoDB', () => {
  let db: Connection;
  let service: PhotosService;
  let storage: any;
  const name = 'darkfantasy_security_test_' + randomUUID().replace(/-/g, '');
  const owner = '507f1f77bcf86cd799439011';
  const other = '507f1f77bcf86cd799439012';
  beforeAll(async () => {
    try {
      db = await createConnection(process.env.TEST_MONGO_URI, {
        dbName: name,
        serverSelectionTimeoutMS: 5000,
      }).asPromise();
    } catch {
      throw new Error('Isolated test MongoDB unavailable');
    }
    storage = {
      presign: jest.fn(async (key: string) => ({
        url: 'https://test.s3.amazonaws.com',
        fields: { key },
      })),
      readVerified: jest.fn().mockResolvedValue(Buffer.from('original')),
      sanitizeAndModerate: jest
        .fn()
        .mockResolvedValue(await sharp({ create: { width: 32, height: 32, channels: 3, background: 'blue' } }).jpeg().toBuffer()),
      putPreview: jest.fn().mockResolvedValue({}),
      putApproved: jest.fn().mockResolvedValue({}),
      copyPrivate: jest.fn().mockResolvedValue({}),
      deleteOne: jest.fn().mockResolvedValue({}),
      keyFromReference: (key: string) => key,
      getSignedURL: jest.fn().mockResolvedValue('https://signed.example/photo'),
      keysUnder: jest.fn().mockResolvedValue([]),
    };
    service = new PhotosService(db, storage);
    await storageIndexes(db, true, () => undefined);
  }, 15000);
  beforeEach(async () => {
    for (const collection of [
      'Users',
      'PhotoUploads',
      'PhotoRateLimits',
      'PhotoDeletionJobs',
      'AccountPurges',
      'Posts',
      'ChatMessages',
    ])
      await db.db.collection(collection).deleteMany({});
    await db.db
      .collection('Users')
      .insertMany([
        { _id: new Types.ObjectId(owner) },
        { _id: new Types.ObjectId(other) },
      ]);
    jest.clearAllMocks();
  });
  afterAll(async () => {
    if (db) {
      if (!db.name.startsWith('darkfantasy_security_test_'))
        throw new Error('Invalid test DB');
      await db.dropDatabase();
      await db.close();
    }
  });

  it('enforces photo quota when concurrent requests target the same slots', async () => {
    const previous = process.env.PHOTO_MAX_PER_USER;
    process.env.PHOTO_MAX_PER_USER = '2';
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () =>
          service.issue(owner, 'image/jpeg', randomUUID()),
        ),
      );
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(2);
      expect(
        await db.db.collection('PhotoUploads').countDocuments({ owner }),
      ).toBe(2);
    } finally {
      if (previous === undefined) delete process.env.PHOTO_MAX_PER_USER;
      else process.env.PHOTO_MAX_PER_USER = previous;
    }
  });
  it('confirms once, supports replay and denies another owner before reading S3', async () => {
    const clientRequestId = randomUUID();
    const issued = await service.issue(owner, 'image/jpeg', clientRequestId);
    const intent = await db.db.collection<any>('PhotoUploads').findOne({ _id: issued.uploadId });
    expect(intent).toMatchObject({ ownerId: owner, resourceType: 'temp', resourceId: issued.uploadId, s3Key: intent.tempKey, status: 'pending', storageLayoutVersion: 1 });
    expect(intent.tempKey).not.toContain(clientRequestId);
    expect((await service.issue(owner, 'image/jpeg', clientRequestId)).uploadId).toBe(issued.uploadId);
    await expect(service.confirm(other, issued.uploadId)).rejects.toThrow(
      'Upload not found',
    );
    expect(storage.readVerified).not.toHaveBeenCalled();
    await service.confirm(owner, issued.uploadId);
    await service.confirm(owner, issued.uploadId);
    expect(storage.putApproved).toHaveBeenCalledTimes(1);
    const row = await db.db
      .collection<any>('PhotoUploads')
      .findOne({ _id: issued.uploadId });
    expect(row.key).toMatch(new RegExp('^temp/' + owner + '/'));
    expect(row.key).not.toContain('original');
  });
  it('does not mark a photo approved when moderation fails', async () => {
    const issued = await service.issue(owner, 'image/jpeg', randomUUID());
    storage.sanitizeAndModerate.mockRejectedValueOnce(
      new Error('moderation unavailable'),
    );
    await expect(service.confirm(owner, issued.uploadId)).rejects.toThrow();
    expect(storage.putApproved).not.toHaveBeenCalled();
    expect(
      await db.db
        .collection('PhotoUploads')
        .countDocuments({ state: 'approved' }),
    ).toBe(0);
  });
  it('allows a photo to bind to only one resource, even under concurrent requests', async () => {
    const issued = await service.issue(owner, 'image/jpeg', randomUUID());
    await service.confirm(owner, issued.uploadId);
    const results = await Promise.allSettled([
      service.bind(owner, [issued.uploadId], 'post:a'),
      service.bind(owner, [issued.uploadId], 'post:b'),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
  });
  it('keeps a failed deletion job and retries instead of silently dropping it', async () => {
    await service.enqueue(['users/' + owner + '/photos/example.jpg']);
    storage.deleteOne.mockRejectedValueOnce(new Error('S3 unavailable'));
    await service.cleanup();
    const job = await db.db.collection('PhotoDeletionJobs').findOne({});
    expect(job.attempts).toBe(1);
    expect(job.dueAt.getTime()).toBeGreaterThan(Date.now());
  });
  it('never deletes an object still referenced by a live post', async () => {
    const key = 'users/' + owner + '/photos/shared.jpg';
    await db.db.collection('Posts').insertOne({ media: [{ filename: key }] });
    await service.enqueue([key]);
    await service.cleanup();
    expect(storage.deleteOne).not.toHaveBeenCalled();
  });

  it('disables the account immediately and retains its purge until S3 deletion succeeds', async () => {
    const issued = await service.issue(owner, 'image/jpeg', randomUUID());
    await service.confirm(owner, issued.uploadId);
    await service.requestAccountDeletion(owner);
    await expect(
      service.issue(owner, 'image/jpeg', randomUUID()),
    ).rejects.toThrow('Account is unavailable');
    await db.db
      .collection('AccountPurges')
      .updateMany({}, { $set: { dueAt: new Date(0) } });
    storage.deleteOne.mockRejectedValue(new Error('S3 unavailable'));
    await service.cleanup();
    expect(await db.db.collection('AccountPurges').countDocuments({})).toBe(1);
    expect(
      await db.db
        .collection('Users')
        .findOne({ _id: new Types.ObjectId(owner) }),
    ).toMatchObject({ isBlocked: true });
    storage.deleteOne.mockResolvedValue({});
    await db.db
      .collection('AccountPurges')
      .updateMany({}, { $set: { dueAt: new Date(0) } });
    await service.cleanup();
    expect(await db.db.collection('AccountPurges').countDocuments({})).toBe(0);
    expect(
      await db.db
        .collection('Users')
        .findOne({ _id: new Types.ObjectId(owner) }),
    ).toBeNull();
  });
});
