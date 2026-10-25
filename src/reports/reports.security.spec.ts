import { reportIndexes } from './report-indexes';
import { S3BucketService } from '../s3-bucket/s3-bucket.service';
import { randomUUID } from 'crypto';
describe('Phase 2 report indexes and private storage', () => {
  it('reports duplicates read-only and refuses apply until open duplicates are resolved', async () => {
    const rows = {
      aggregate: () => ({ toArray: async () => [{ count: 2 }] }),
      createIndex: jest.fn(),
    };
    const db: any = { db: { collection: () => rows } };
    expect(await reportIndexes(db, false, () => {})).toEqual([{ count: 2 }]);
    expect(rows.createIndex).not.toHaveBeenCalled();
    await expect(reportIndexes(db, true, () => {})).rejects.toThrow(
      'duplicate open cases',
    );
    expect(rows.createIndex).not.toHaveBeenCalled();
  });
  it('creates the partial open-report unique index only on explicit apply and never installs evidence TTL', async () => {
    const createIndex = jest.fn();
    const db: any = {
      db: {
        collection: () => ({
          aggregate: () => ({ toArray: async () => [] }),
          createIndex,
        }),
      },
    };
    await reportIndexes(db, false, () => {});
    expect(createIndex).not.toHaveBeenCalled();
    await reportIndexes(db, true, () => {});
    expect(createIndex).toHaveBeenCalledWith(
      { reporterId: 1, targetType: 1, targetId: 1 },
      {
        name: 'report_open_unique',
        unique: true,
        partialFilterExpression: { open: true },
      },
    );
    expect(
      createIndex.mock.calls.every(
        ([, options]) => options.expireAfterSeconds === undefined,
      ),
    ).toBe(true);
  });
  it('copies evidence server-side with replaced metadata, private encryption and no-store; generic signing refuses reports', async () => {
    const before = { ...process.env };
    process.env.AWS_DEFAULT_S3_BUCKET = 'private-test';
    process.env.AWS_S3_REGION = 'ap-south-1';
    delete process.env.PHOTO_MEDIA_BUCKET;
    delete process.env.PHOTO_PRIVATE_BUCKET;
    try {
      const service = new S3BucketService();
      jest.spyOn(service, 'ensurePrivate').mockResolvedValue();
      const copyObject = jest.fn().mockResolvedValue({}),
        headObject = jest
          .fn()
          .mockResolvedValue({ ETag: 'same-etag', ContentType: 'image/jpeg' });
      service.s3 = { headObject, copyObject } as any;
      const destination = `reports/${randomUUID()}/${randomUUID()}-0.jpg`;
      await service.copyReportEvidence(
        'chat/conversation/message/image.jpg',
        destination,
      );
      expect(copyObject).toHaveBeenCalledWith(
        expect.objectContaining({
          Key: destination,
          MetadataDirective: 'REPLACE',
          Metadata: {},
          CacheControl: 'no-store',
          ContentType: 'image/jpeg',
          ServerSideEncryption: 'AES256',
          CopySourceIfMatch: 'same-etag',
        }),
      );
      await expect(service.getSignedURL(destination)).rejects.toThrow(
        'Evidence cannot be signed',
      );
      await expect(
        service.copyReportEvidence('vault/owner/image.jpg', destination),
      ).rejects.toThrow('Invalid evidence');
    } finally {
      process.env = before;
    }
  });
});
