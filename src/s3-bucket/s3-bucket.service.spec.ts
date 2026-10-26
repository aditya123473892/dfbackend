import { Test, TestingModule } from '@nestjs/testing';
import { S3BucketService } from './s3-bucket.service';
import sharp = require('sharp');

describe('S3BucketService', () => {
  let service: S3BucketService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [S3BucketService],
    }).compile();

    service = module.get<S3BucketService>(S3BucketService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('copies private media with replaced metadata and an ETag condition, without fetching pixels', async () => {
    jest.spyOn(service, 'ensurePrivate').mockResolvedValue(undefined);
    jest.spyOn(service, 'bucketFor').mockImplementation(key => key.startsWith('temp/') ? 'source-bucket' : 'private-bucket');
    const copyObject = jest.fn(async () => ({}));
    service.s3 = { headObject: async () => ({ ETag: 'immutable-etag', ContentType: 'image/jpeg' }), copyObject } as any;
    const sanitize = jest.spyOn(service, 'sanitizeAndModerate');
    await service.copyPrivate('temp/owner/server.jpg', 'chat/conversation/message/server.jpg');
    expect(copyObject).toHaveBeenCalledWith(expect.objectContaining({
      Bucket: 'private-bucket', Key: 'chat/conversation/message/server.jpg',
      CopySource: 'source-bucket/temp/owner/server.jpg', CopySourceIfMatch: 'immutable-etag',
      MetadataDirective: 'REPLACE', ContentType: 'image/jpeg', CacheControl: 'private, no-store',
    }));
    expect(sanitize).not.toHaveBeenCalled();
  });

  it('compresses photos to JPEG within 1080x1920 and strips EXIF/GPS', async () => {
    const scanner = jest.spyOn(service as any, 'moderationResult').mockResolvedValue({
      ModerationModelVersion: 'test', ModerationLabels: [],
    });
    const previous = process.env.PHOTO_MODERATION_MODE;
    process.env.PHOTO_MODERATION_MODE = 'rekognition';
    try {
      const source = await sharp({ create: { width: 2160, height: 3840, channels: 3, background: '#b08060' } })
        .jpeg({ quality: 100 }).withExif({ IFD0: { Artist: 'Private metadata' } }).toBuffer();
      expect((await sharp(source).metadata()).exif).toBeDefined();
      const clean = await service.sanitizeAndModerate(source);
      const meta = await sharp(clean).metadata();
      expect(meta.format).toBe('jpeg');
      expect(meta.width).toBe(1080); expect(meta.height).toBe(1920);
      expect(meta.exif).toBeUndefined(); expect(meta.xmp).toBeUndefined();
      expect(clean.length).toBeLessThan(source.length);
      expect(scanner).toHaveBeenCalledWith(clean);
    } finally {
      if (previous === undefined) delete process.env.PHOTO_MODERATION_MODE;
      else process.env.PHOTO_MODERATION_MODE = previous;
    }
  });
});
