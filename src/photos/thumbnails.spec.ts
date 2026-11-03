import { NotFoundException } from '@nestjs/common';
import sharp = require('sharp');
import { PhotosService } from './photos.service';
import { ResourceContext } from '../s3-bucket/storage-layout';

const owner = '507f1f77bcf86cd799439011';
const post = '507f1f77bcf86cd799439013';
const key = `posts/${owner}/${post}/12345678-1234-4234-8234-123456789abc/original.jpg`;
const thumbKey = key.replace('original.jpg', '480.webp');

function harness(row: any) {
  const uploads = {
    findOneAndUpdate: jest.fn(async () => row),
    updateOne: jest.fn(async () => ({ matchedCount: 1 })),
    findOne: jest.fn(async () => row),
  };
  const jobs = { updateOne: jest.fn(async () => ({})) };
  const postRow = { _id: post, user: owner, visibility: 'public', status: 'approved' };
  const db: any = { db: { collection: (name: string) =>
    name === 'PhotoUploads' ? uploads : name === 'PhotoDeletionJobs' ? jobs : {
      findOne: async () => (name === 'Users' ? { _id: owner } : name === 'Posts' ? postRow : null),
    } } };
  const storage: any = {
    keyFromReference: (value: string) => value,
    readVerified: jest.fn(),
    putApproved: jest.fn(async () => ({})),
    getSignedURL: jest.fn(async (target: string) => `https://s3.test/${target}`),
  };
  return { service: new PhotosService(db, storage), uploads, jobs, storage };
}

describe('Grid thumbnails', () => {
  it('stores a small WebP beside the original, registering its cleanup before writing it', async () => {
    const { service, uploads, jobs, storage } = harness({ _id: 'p1', s3Key: key, key, state: 'attached', resourceType: 'post' });
    storage.readVerified.mockResolvedValue(
      await sharp({ create: { width: 1080, height: 1350, channels: 3, background: '#808080' } }).jpeg().toBuffer(),
    );
    await service.buildThumbnail('p1');
    expect(storage.readVerified).toHaveBeenCalledWith(key, 'image/jpeg');
    expect(storage.putApproved).toHaveBeenCalledWith(thumbKey, expect.any(Buffer), 'image/webp');
    expect(jobs.updateOne.mock.invocationCallOrder[0]).toBeLessThan(storage.putApproved.mock.invocationCallOrder[0]);
    const thumb = await sharp(storage.putApproved.mock.calls[0][1]).metadata();
    expect([thumb.format, thumb.width, thumb.height]).toEqual(['webp', 480, 600]);
    expect(uploads.updateOne).toHaveBeenLastCalledWith(
      expect.objectContaining({ _id: 'p1', state: 'attached' }),
      expect.objectContaining({ $set: { thumbKey } }),
    );
  });

  it('skips photos another process claimed or that already have one', async () => {
    const { service, storage } = harness(null);
    await service.buildThumbnail('p1');
    expect(storage.readVerified).not.toHaveBeenCalled();
  });

  it('marks legacy-layout photos as having none, and gives up after three failures', async () => {
    const legacy = harness({ _id: 'p1', s3Key: `users/${owner}/photos/legacy.jpg`, state: 'attached', resourceType: 'post' });
    await legacy.service.buildThumbnail('p1');
    expect(legacy.storage.readVerified).not.toHaveBeenCalled();
    expect(legacy.uploads.updateOne).toHaveBeenCalledWith({ _id: 'p1' }, expect.objectContaining({ $set: { thumbUnavailable: true } }));

    const failing = harness({ _id: 'p2', s3Key: key, state: 'attached', resourceType: 'post', thumbAttempts: 2 });
    failing.storage.readVerified.mockRejectedValue(new Error('S3 unavailable'));
    await failing.service.buildThumbnail('p2');
    expect(failing.storage.putApproved).not.toHaveBeenCalled();
    expect(failing.uploads.updateOne).toHaveBeenLastCalledWith({ _id: 'p2' }, expect.objectContaining({
      $set: { thumbAttempts: 3, thumbUnavailable: true },
    }));
  });

  it('signs the thumbnail only with the original\'s checks, and only when one exists', async () => {
    const context: ResourceContext = { ownerId: owner, resourceType: 'post', resourceId: post, requester: owner };
    const row: any = { ownerId: owner, resourceType: 'post', resourceId: post, s3Key: key, state: 'attached', thumbKey };
    const { service, storage } = harness(row);
    await expect(service.accessUrl(key, 120, context, false, undefined, 'thumbnail')).resolves.toBe(`https://s3.test/${thumbKey}`);
    expect(storage.getSignedURL).toHaveBeenCalledWith(thumbKey, undefined, 120, false);
    await expect(service.accessUrl(key, 120, { ...context, ownerId: 'other' }, false, undefined, 'thumbnail'))
      .rejects.toThrow(NotFoundException);
    delete row.thumbKey;
    await expect(service.accessUrl(key, 120, context, false, undefined, 'thumbnail')).rejects.toThrow(NotFoundException);
  });
});
