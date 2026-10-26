import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
  ValidationPipe,
} from '@nestjs/common';
import { PhotosService } from './photos.service';
import {
  S3BucketService,
  PHOTO_MAX_BYTES,
} from '../s3-bucket/s3-bucket.service';
import { PostsController } from '../posts/posts.controller';
import { SelfProfileDto } from '../users/dtos/self-profile.dto';
import { PhotoPostDto } from '../posts/dto/photo-post.dto';
import { Readable } from 'stream';
import sharp = require('sharp');
import { S3 } from '@aws-sdk/client-s3';

describe('Photo security boundaries', () => {
  it('skips AWS moderation only in explicit development mode while still sanitizing', async () => {
    const previousMode = process.env.PHOTO_MODERATION_MODE;
    const previousEnvironment = process.env.NODE_ENV;
    process.env.PHOTO_MODERATION_MODE = 'development-bypass';
    process.env.NODE_ENV = 'development';
    try {
      const storage = new S3BucketService();
      const scan = jest.spyOn(storage as any, 'moderationResult');
      const input = await sharp({
        create: { width: 1200, height: 800, channels: 3, background: 'blue' },
      })
        .withMetadata()
        .jpeg()
        .toBuffer();
      const clean = await storage.sanitizeAndModerate(input);
      const metadata = await sharp(clean).metadata();
      expect(metadata.width).toBe(1080);
      expect(metadata.exif).toBeUndefined();
      expect(scan).not.toHaveBeenCalled();
      await expect(
        storage.sanitizeAndModerate(Buffer.from('not an image')),
      ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
      for (const environment of ['production', 'staging', '']) {
        process.env.NODE_ENV = environment;
        expect(() => storage.onModuleInit()).toThrow(ServiceUnavailableException);
        await expect(storage.sanitizeAndModerate(input)).rejects.toBeInstanceOf(
          ServiceUnavailableException,
        );
      }
    } finally {
      restoreEnv('PHOTO_MODERATION_MODE', previousMode);
      restoreEnv('NODE_ENV', previousEnvironment);
    }
  });

  it('allows the explicit temporary bucket-check override without configuration reads', async () => {
    const previous = process.env.PHOTO_VERIFY_BUCKET_SETTINGS;
    process.env.PHOTO_VERIFY_BUCKET_SETTINGS = 'false';
    try {
      const storage = new S3BucketService();
      const check = jest.spyOn(storage as any, 'verifyConfiguration');
      await expect(storage.ensurePrivate()).resolves.toBeUndefined();
      expect(check).not.toHaveBeenCalled();
    } finally {
      restoreEnv('PHOTO_VERIFY_BUCKET_SETTINGS', previous);
    }
  });

  it('refuses to sign uploads when bucket privacy cannot be established', async () => {
    const storage = new S3BucketService();
    jest.spyOn(storage, 'bucket', 'get').mockReturnValue('test-photo-bucket');
    const result = (value: any) => async () => value;
    storage.s3 = {
      getPublicAccessBlock: result({
        PublicAccessBlockConfiguration: { BlockPublicAcls: false },
      }),
      getBucketOwnershipControls: result({
        OwnershipControls: {
          Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }],
        },
      }),
      getBucketEncryption: result({
        ServerSideEncryptionConfiguration: {
          Rules: [
            { ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
          ],
        },
      }),
      getBucketLifecycleConfiguration: result({ Rules: [] }),
      getBucketCors: result({ CORSRules: [] }),
    } as any;
    await expect(
      storage.presign('temp/owner/photo.jpg', 'image/jpeg'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('does not queue or delete any S3 object when a caller does not own the post', async () => {
    const posts: any = {
      findByIdPrivate: jest.fn().mockResolvedValue(null),
      removePrivate: jest.fn(),
    };
    const photos: any = { enqueue: jest.fn(), release: jest.fn() };
    const storage: any = { deleteOne: jest.fn() };
    const controller = new PostsController(posts, photos, storage, { bind: jest.fn(), release: jest.fn() } as any);
    await expect(
      controller.remove('507f1f77bcf86cd799439011', {
        id: '507f1f77bcf86cd799439012',
      } as any),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(photos.enqueue).not.toHaveBeenCalled();
    expect(storage.deleteOne).not.toHaveBeenCalled();
    expect(posts.removePrivate).not.toHaveBeenCalled();
  });

  it('preserves photo references during a text-only edit', async () => {
    const media = [{ filename: 'users/owner/photos/photo.jpg' }];
    const posts: any = {
      findByIdPrivate: jest.fn().mockResolvedValue({ media, __v: 3 }),
      updateOnePrivate: jest.fn().mockResolvedValue({ media }),
      findVisiblePost: jest.fn().mockResolvedValue({ media }),
    };
    const photos: any = {
      bind: jest.fn(),
      retire: jest.fn(),
      enqueue: jest.fn(),
    };
    const controller = new PostsController(posts, photos, {} as any, { bind: jest.fn(), release: jest.fn() } as any);
    await controller.update('507f1f77bcf86cd799439011', { caption: 'Edited' }, {
      id: 'owner',
    } as any);
    expect(posts.updateOnePrivate).toHaveBeenCalledWith(
      expect.any(String),
      { caption: 'Edited' },
      { id: 'owner' },
      3,
    );
    expect(photos.bind).not.toHaveBeenCalled();
    expect(photos.retire).not.toHaveBeenCalled();
    expect(photos.enqueue).not.toHaveBeenCalled();
    expect(posts.findVisiblePost).toHaveBeenCalledWith('507f1f77bcf86cd799439011', 'owner');
  });

  it('rejects client-written privilege, approval, key and path fields', async () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    await expect(
      pipe.transform(
        {
          displayname: 'Name',
          roles: ['root'],
          avatar: 'users/victim/photos/a.jpg',
        },
        {
          type: 'body',
          metatype: SelfProfileDto,
        },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      pipe.transform(
        {
          clientId: 'request-123',
          photoIds: ['ed6942a6-b784-4d9d-8d44-97734ae67791'],
          status: 'approved',
          user: 'victim',
          key: 'arbitrary',
        },
        { type: 'body', metatype: PhotoPostDto },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('signs a POST with exact type/key, 5MB range and <=300-second expiry', async () => {
    const storage = new S3BucketService();
    const old = {
      bucket: process.env.AWS_DEFAULT_S3_BUCKET,
      region: process.env.AWS_S3_REGION,
    };
    jest.spyOn(storage, 'ensurePrivate').mockResolvedValue(undefined);
    process.env.AWS_DEFAULT_S3_BUCKET = 'test-photo-bucket';
    process.env.AWS_S3_REGION = 'ap-south-1';
    storage.s3 = new S3({ region: 'ap-south-1', credentials: { accessKeyId: 'test-key', secretAccessKey: 'test-secret' } });
    const started = Date.now();
    const signed = await storage.presign('temp/owner/server-uuid.jpg', 'image/jpeg', 999);
    const policy = JSON.parse(Buffer.from(signed.fields.Policy, 'base64').toString());
    expect(Date.parse(policy.expiration)).toBeLessThanOrEqual(started + 300000);
    expect(Date.parse(policy.expiration)).toBeGreaterThan(started + 290000);
    expect(policy.conditions).toEqual(expect.arrayContaining([
        ['eq', '$key', 'temp/owner/server-uuid.jpg'],
        ['eq', '$Content-Type', 'image/jpeg'],
        ['eq', '$success_action_status', '204'],
        ['content-length-range', 1, PHOTO_MAX_BYTES],
    ]));
    expect(signed.fields).toMatchObject({ key: 'temp/owner/server-uuid.jpg', 'Content-Type': 'image/jpeg' });
    storage.s3.destroy();
    restoreEnv('AWS_DEFAULT_S3_BUCKET', old.bucket);
    restoreEnv('AWS_S3_REGION', old.region);
  });

  it('checks HEAD, constrains GET to the same ETag and rejects fake JPEG bytes', async () => {
    const storage = new S3BucketService();
    jest.spyOn(storage, 'bucket', 'get').mockReturnValue('test-photo-bucket');
    const getObject = jest.fn(async () => ({
      Body: Readable.from([Buffer.alloc(12)]),
    }));
    storage.s3 = {
      headObject: async () => ({
          ContentLength: 12,
          ContentType: 'image/jpeg',
          ETag: 'immutable-etag',
      }),
      getObject,
    } as any;
    await expect(
      storage.readVerified('temp/owner/photo.jpg', 'image/jpeg'),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
    expect(getObject).toHaveBeenCalledWith({
      Bucket: 'test-photo-bucket',
      Key: 'temp/owner/photo.jpg',
      IfMatch: 'immutable-etag',
    });
  });

  it('strips metadata, limits dimensions and calls moderation on the sanitized pixels', async () => {
    const storage = new S3BucketService();
    const scan = jest
      .spyOn(storage as any, 'moderationResult')
      .mockResolvedValue({
        ModerationModelVersion: 'test',
        ModerationLabels: [],
      });
    const input = await sharp({
      create: { width: 1600, height: 1200, channels: 3, background: '#ff8800' },
    })
      .withMetadata({ exif: { IFD0: { Artist: 'Private metadata' } } })
      .jpeg()
      .toBuffer();
    expect((await sharp(input).metadata()).exif).toBeDefined();
    const clean = await storage.sanitizeAndModerate(input);
    const metadata = await sharp(clean).metadata();
    expect(metadata.width).toBe(1080);
    expect(metadata.exif).toBeUndefined();
    expect(scan).toHaveBeenCalledWith(clean);
  });

  it('fails closed for unavailable, incomplete or flagged moderation', async () => {
    const storage = new S3BucketService();
    const image = await sharp({
      create: { width: 10, height: 10, channels: 3, background: 'red' },
    })
      .jpeg()
      .toBuffer();
    const scan = jest
      .spyOn(storage as any, 'moderationResult')
      .mockRejectedValue(new Error('scanner offline'));
    await expect(storage.sanitizeAndModerate(image)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    scan.mockResolvedValue({});
    await expect(storage.sanitizeAndModerate(image)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    scan.mockResolvedValue({
      ModerationModelVersion: 'test',
      ModerationLabels: [{ Name: 'Explicit' }],
    });
    await expect(storage.sanitizeAndModerate(image)).rejects.toBeInstanceOf(
      UnsupportedMediaTypeException,
    );
  });
});

function restoreEnv(name: string, value?: string) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
