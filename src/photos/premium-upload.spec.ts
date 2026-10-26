import { BadRequestException, UnsupportedMediaTypeException } from '@nestjs/common';
import { Readable } from 'stream';
import { PhotosService } from './photos.service';
import { S3BucketService, PHOTO_MAX_BYTES } from '../s3-bucket/s3-bucket.service';

describe('Premium upload confirmation boundary', () => {
  const owner = '507f1f77bcf86cd799439011';
  const other = '507f1f77bcf86cd799439012';
  const id = '12345678-1234-4234-8234-123456789abc';

  it.each([
    ['wrong content type', { ContentLength: 12, ContentType: 'text/plain', ETag: 'etag' }, BadRequestException],
    ['oversized object', { ContentLength: PHOTO_MAX_BYTES + 1, ContentType: 'image/jpeg', ETag: 'etag' }, BadRequestException],
    ['false magic bytes', { ContentLength: 12, ContentType: 'image/jpeg', ETag: 'etag' }, UnsupportedMediaTypeException],
  ])('confirm rejects %s before preview or attachment', async (_label, head, errorClass) => {
    const photo = { _id: id, owner, state: 'pending', tempKey: `temp/${owner}/${id}.jpg`,
      contentType: 'image/jpeg', expiresAt: new Date(Date.now() + 60000) };
    const db: any = { db: { collection: (name: string) => ({
      findOne: async () => name === 'PhotoUploads' ? photo : name === 'Users' ? { _id: owner } : name === 'PhotoRateLimits' ? { count: 1 } : null,
      updateOne: async () => ({ modifiedCount: 1, matchedCount: 1 }),
    }) } };
    const storage = new S3BucketService();
    jest.spyOn(storage, 'bucket', 'get').mockReturnValue('test-bucket');
    storage.s3 = { headObject: async () => head, getObject: async () => ({ Body: Readable.from([Buffer.alloc(12)]) }) } as any;
    const preview = jest.spyOn(storage, 'putPreview');
    const original = jest.spyOn(storage, 'putApproved');
    await expect(new PhotosService(db, storage).confirm(owner, id)).rejects.toBeInstanceOf(errorClass);
    expect(preview).not.toHaveBeenCalled();
    expect(original).not.toHaveBeenCalled();
  });

  it('does not let user A attach user B’s confirmed photo ID', async () => {
    const photo = { _id: id, owner: other, state: 'approved', key: `posts/${other}/secret.jpg` };
    const db: any = { db: { collection: (name: string) => ({ findOne: async (filter: any) =>
      name === 'Users' ? { _id: owner } : name === 'PhotoUploads' && filter.owner === photo.owner ? photo : null }) } };
    const storage: any = { copyPrivate: jest.fn() };
    await expect(new PhotosService(db, storage).bind(owner, [id], `post:${owner}`)).rejects.toBeInstanceOf(BadRequestException);
    expect(storage.copyPrivate).not.toHaveBeenCalled();
  });
});
