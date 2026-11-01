import { createHash } from 'node:crypto';
import { S3BucketService } from './s3-bucket.service';
import { bucketForKey } from './storage-layout';

describe('Private deleted vault archive', () => {
  const owner = '0123456789abcdef01234567', id = '12345678-1234-4234-8234-123456789abc';
  const key = `vault/${owner}/${id}.jpg`;
  it('copies, verifies, and retries idempotently without returning a signed URL', async () => {
    const service = new S3BucketService();
    jest.spyOn(service, 'bucketFor').mockReturnValue('private-bucket');
    jest.spyOn(service, 'ensurePrivate').mockResolvedValue();
    const metadata = { 'source-key-hash': createHash('sha256').update(key).digest('hex') };
    const s3: any = { headObject: jest.fn()
      .mockRejectedValueOnce({ name: 'NotFound' })
      .mockResolvedValueOnce({ ETag: 'etag', ContentLength: 5, ContentType: 'image/jpeg' })
      .mockResolvedValue({ ContentLength: 5, Metadata: metadata }), copyObject: jest.fn().mockResolvedValue({}) };
    service.s3 = s3;
    const archive = await service.archiveDeletedVault(key, owner, id);
    expect(archive).toMatch(new RegExp(`^deleted/vault/${owner}/${id}/`));
    expect(s3.copyObject).toHaveBeenCalledWith(expect.objectContaining({
      Bucket: 'private-bucket', Key: archive, CopySourceIfMatch: 'etag', CacheControl: 'private, no-store',
    }));
    await expect(service.archiveDeletedVault(key, owner, id)).resolves.toBe(archive);
    expect(s3.copyObject).toHaveBeenCalledTimes(1);
    await expect(service.getSignedURL(archive)).rejects.toThrow('not user accessible');
  });
  it('routes deleted files to the private bucket and refuses foreign ownership', async () => {
    const previous = process.env.PHOTO_PRIVATE_BUCKET;
    try {
      process.env.PHOTO_PRIVATE_BUCKET = 'private-bucket';
      expect(bucketForKey('deleted/vault/a', 'fallback')).toBe('private-bucket');
      await expect(new S3BucketService().archiveDeletedVault('vault/other/photo.jpg', owner, id)).rejects.toThrow('binding');
    } finally {
      if (previous === undefined) delete process.env.PHOTO_PRIVATE_BUCKET; else process.env.PHOTO_PRIVATE_BUCKET = previous;
    }
  });
});
