import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { S3, S3ClientConfig, GetObjectCommand, LifecycleRule } from '@aws-sdk/client-s3';
import { Rekognition, DetectModerationLabelsResponse } from '@aws-sdk/client-rekognition';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'node:stream';
import sharp = require('sharp');
import { bucketForKey } from './storage-layout';

export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
export const VIDEO_TYPES = ['video/mp4', 'video/quicktime'] as const;
export type VideoContentType = (typeof VIDEO_TYPES)[number];
/** Default 50 MB, operator-tunable up to 200 MB. */
export function videoMaxBytes() {
  const configured = Number(process.env.VIDEO_MAX_BYTES) || 50 * 1024 * 1024;
  return Math.min(200 * 1024 * 1024, Math.max(1024 * 1024, Math.floor(configured)));
}
/** ISO base media (MP4/MOV) files start with a size word followed by an `ftyp` box. */
export function videoType(bytes: Buffer): VideoContentType | undefined {
  if (bytes.length < 12 || bytes.toString('ascii', 4, 8) !== 'ftyp') return undefined;
  return bytes.toString('ascii', 8, 12) === 'qt  ' ? 'video/quicktime' : 'video/mp4';
}
export type VideoScan = 'pending' | 'approved' | 'rejected';
export function imageType(bytes: Buffer): string | undefined {
  if (
    bytes.length >= 12 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
    return 'image/jpeg';
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'image/webp';
}

@Injectable()
export class S3BucketService implements OnModuleInit {
  private get developmentModerationBypass(): boolean {
    const mode = process.env.PHOTO_MODERATION_MODE || 'rekognition';
    if (mode === 'rekognition') return false;
    if (
      mode === 'development-bypass' &&
      ['development', 'test'].includes(process.env.NODE_ENV || '')
    )
      return true;
    throw new ServiceUnavailableException(
      'PHOTO_MODERATION_MODE must be rekognition outside development/test',
    );
  }
  onModuleInit() {
    if (this.developmentModerationBypass)
      Logger.warn(
        'Development photo mode: content moderation is disabled',
        S3BucketService.name,
      );
  }
  private get options(): S3ClientConfig {
    const accessKeyId =
      process.env.AWS_ACCESS_KEY || process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey =
      process.env.AWS_SECRET || process.env.AWS_SECRET_ACCESS_KEY;
    if (!!accessKeyId !== !!secretAccessKey)
      throw new Error(
        'Both AWS credential variables are required when using static credentials',
      );
    return {
      region: process.env.AWS_S3_REGION || process.env.AWS_REGION,
      requestHandler: { connectionTimeout: 5000, requestTimeout: 30000 },
      maxAttempts: 3,
      ...(accessKeyId
        ? {
            credentials: {
              accessKeyId,
              secretAccessKey,
              sessionToken: process.env.AWS_SESSION_TOKEN,
            },
          }
        : {}),
    };
  }
  private client?: S3;
  private configurations = new Map<string, { until: number; check: Promise<void> }>();
  get s3() {
    return (this.client ||= new S3(this.options));
  }
  set s3(client: S3) {
    this.client = client;
  }
  get bucket(): string {
    const value = process.env.AWS_DEFAULT_S3_BUCKET;
    if (!value || !(process.env.AWS_S3_REGION || process.env.AWS_REGION)) {
      throw new ServiceUnavailableException('Photo storage is not configured');
    }
    return value;
  }
  bucketFor(key: string) { return bucketForKey(key, this.bucket); }
  async copyPrivate(sourceKey: string, destinationKey: string) {
    const source = this.bucketFor(sourceKey);
    await Promise.all([this.ensurePrivate(source), this.ensurePrivate(this.bucketFor(destinationKey))]);
    const head = await this.s3.headObject({ Bucket: source, Key: sourceKey });
    if (!head.ETag || head.ContentType !== 'image/jpeg') throw new BadRequestException('Invalid prepared photo');
    return this.s3.copyObject({
      Bucket: this.bucketFor(destinationKey), Key: destinationKey,
      CopySource: `${source}/${sourceKey.split('/').map(encodeURIComponent).join('/')}`,
      CopySourceIfMatch: head.ETag, MetadataDirective: 'REPLACE',
      ContentType: 'image/jpeg', CacheControl: /^(chat|vault)\//.test(destinationKey) ? 'private, no-store' : 'private, max-age=120',
      ContentDisposition: 'inline', ServerSideEncryption: 'AES256',
    });
  }
  /** Server-only evidence writer. Never signs or returns evidence URLs. */
  async copyReportEvidence(sourceKey: string, destinationKey: string) {
    if (!/^reports\/[0-9a-f-]+\/[0-9a-f-]+\.jpg$/.test(destinationKey) || /^(vault|temp|reports|quarantine)\//.test(sourceKey))
      throw new BadRequestException('Invalid evidence storage binding');
    const sourceBucket = this.bucketFor(sourceKey), destinationBucket = this.bucketFor(destinationKey);
    await Promise.all([this.ensurePrivate(sourceBucket), this.ensurePrivate(destinationBucket)]);
    const head = await this.s3.headObject({ Bucket: sourceBucket, Key: sourceKey });
    if (!head.ETag || head.ContentType !== 'image/jpeg') throw new BadRequestException('Invalid evidence image');
    return this.s3.copyObject({ Bucket: destinationBucket, Key: destinationKey,
      CopySource: `${sourceBucket}/${sourceKey.split('/').map(encodeURIComponent).join('/')}`,
      CopySourceIfMatch: head.ETag, MetadataDirective: 'REPLACE', Metadata: {},
      ContentType: 'image/jpeg', CacheControl: 'no-store', ContentDisposition: 'inline', ServerSideEncryption: 'AES256' });
  }
  async uploadFile(_file: unknown, _folder: string): Promise<any> {
    throw new BadRequestException(
      'Upload images through /photos/upload-url and /photos/confirm',
    );
  }
  async uploadPrivateFile(
    _file: Express.Multer.File,
    _key: string,
  ): Promise<any> {
    throw new BadRequestException(
      'Upload images through /photos/upload-url and /photos/confirm',
    );
  }
  async presign(key: string, contentType: string, seconds = 300, maxBytes = PHOTO_MAX_BYTES) {
    await this.ensurePrivate(this.bucketFor(key));
    return createPresignedPost(this.s3, {
      Bucket: this.bucketFor(key),
      Key: key,
      Expires: Math.max(1, Math.min(300, seconds)),
      Fields: {
        key,
        'Content-Type': contentType,
        success_action_status: '204',
      },
      Conditions: [
        ['eq', '$key', key],
        ['eq', '$Content-Type', contentType],
        ['eq', '$success_action_status', '204'],
        ['content-length-range', 1, maxBytes],
      ],
    });
  }
  /**
   * Videos are never buffered whole: check the declared size/type, then sniff
   * only the container header with a ranged, ETag-pinned read.
   */
  async verifyVideo(key: string, expectedType: string) {
    if (!(VIDEO_TYPES as readonly string[]).includes(expectedType))
      throw new UnsupportedMediaTypeException('Only MP4 and MOV videos are supported');
    const head = await this.s3.headObject({ Bucket: this.bucketFor(key), Key: key });
    if (!head.ContentLength || head.ContentLength > videoMaxBytes() ||
        head.ContentType !== expectedType || !head.ETag)
      throw new BadRequestException('Invalid video size or type');
    const result = await this.s3.getObject({ Bucket: this.bucketFor(key), Key: key, IfMatch: head.ETag, Range: 'bytes=0-31' });
    const stream = result.Body as Readable;
    if (!stream) throw new BadRequestException('Video body is missing');
    const chunks: Buffer[] = [];
    for await (const part of stream) chunks.push(Buffer.from(part));
    if (!videoType(Buffer.concat(chunks)))
      throw new UnsupportedMediaTypeException('Video content does not match its declared type');
    return { size: head.ContentLength, etag: head.ETag };
  }
  /** Server-side copy of a verified video; the source ETag pins exactly what was scanned. */
  async copyVideo(sourceKey: string, destinationKey: string, contentType: string, etag: string) {
    if (!(VIDEO_TYPES as readonly string[]).includes(contentType)) throw new BadRequestException('Invalid video type');
    const source = this.bucketFor(sourceKey);
    await Promise.all([this.ensurePrivate(source), this.ensurePrivate(this.bucketFor(destinationKey))]);
    return this.s3.copyObject({
      Bucket: this.bucketFor(destinationKey), Key: destinationKey,
      CopySource: `${source}/${sourceKey.split('/').map(encodeURIComponent).join('/')}`,
      CopySourceIfMatch: etag, MetadataDirective: 'REPLACE', ContentType: contentType,
      CacheControl: /^vault\//.test(destinationKey) ? 'private, no-store' : 'private, max-age=120',
      ContentDisposition: 'inline', ServerSideEncryption: 'AES256',
    });
  }
  /**
   * Starts asynchronous Rekognition video moderation. Returns null when the
   * development bypass is active, meaning the video is approved immediately.
   */
  async startVideoModeration(key: string): Promise<string | null> {
    if (this.developmentModerationBypass) return null;
    try {
      const { JobId } = await this.videoScanner().startContentModeration({
        Video: { S3Object: { Bucket: this.bucketFor(key), Name: key } }, MinConfidence: 60,
      });
      if (!JobId) throw new Error('Missing moderation job');
      return JobId;
    } catch {
      throw new ServiceUnavailableException('Video moderation is temporarily unavailable');
    }
  }
  /** Any moderation label, or a failed/unreadable scan, rejects the video. */
  async videoModerationResult(jobId: string): Promise<VideoScan> {
    let result;
    try {
      result = await this.videoScanner().getContentModeration({ JobId: jobId, MaxResults: 1 });
    } catch {
      throw new ServiceUnavailableException('Video moderation is temporarily unavailable');
    }
    if (result.JobStatus === 'IN_PROGRESS') return 'pending';
    if (result.JobStatus !== 'SUCCEEDED' || !Array.isArray(result.ModerationLabels)) return 'rejected';
    return result.ModerationLabels.length ? 'rejected' : 'approved';
  }
  protected videoScanner() {
    return new Rekognition({ ...this.options, region: process.env.AWS_REKOGNITION_REGION || this.options.region });
  }
  async readVerified(key: string, expectedType: string) {
    const head = await this.s3
      .headObject({ Bucket: this.bucketFor(key), Key: key });
    if (
      !head.ContentLength ||
      head.ContentLength > PHOTO_MAX_BYTES ||
      head.ContentType !== expectedType ||
      !head.ETag
    ) {
      throw new BadRequestException('Invalid image size or type');
    }
    const result = await this.s3.getObject({ Bucket: this.bucketFor(key), Key: key, IfMatch: head.ETag });
    const stream = result.Body as Readable;
    if (!stream) throw new BadRequestException('Image body is missing');
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const part of stream) {
      const chunk = Buffer.from(part);
      length += chunk.length;
      if (length > PHOTO_MAX_BYTES) {
        stream.destroy();
        throw new BadRequestException('Image exceeds 5MB');
      }
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (
      bytes.length !== head.ContentLength ||
      imageType(bytes) !== expectedType
    ) {
      throw new UnsupportedMediaTypeException(
        'Image content does not match its declared type',
      );
    }
    return bytes;
  }
  async sanitizeAndModerate(bytes: Buffer) {
    const bypassModeration = this.developmentModerationBypass;
    if (!imageType(bytes))
      throw new UnsupportedMediaTypeException(
        'Only JPEG and WebP images are supported',
      );
    let clean: Buffer;
    try {
      const decoder = sharp(bytes, {
        limitInputPixels: 40_000_000,
        failOn: 'warning',
      });
      const metadata = await decoder.metadata();
      if ((metadata.pages || 1) > 1) throw new Error('Animated image');
      // Re-encode pixels without withMetadata/keepMetadata, removing EXIF/GPS.
      clean = await decoder
        .rotate()
        .resize({
          width: 1080,
          height: 1920,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: 80 })
        .toBuffer();
      if (clean.length > PHOTO_MAX_BYTES)
        throw new Error('Processed image is too large');
    } catch {
      throw new UnsupportedMediaTypeException(
        'Image could not be decoded safely',
      );
    }
    if (bypassModeration) return clean;
    try {
      const result = await this.moderationResult(clean);
      if (
        !result.ModerationModelVersion ||
        !Array.isArray(result.ModerationLabels)
      )
        throw new Error('Incomplete moderation result');
      if (result.ModerationLabels.length)
        throw new UnsupportedMediaTypeException(
          'Image did not pass moderation',
        );
    } catch (error) {
      if (error instanceof UnsupportedMediaTypeException) throw error;
      throw new ServiceUnavailableException(
        'Image moderation is temporarily unavailable',
      );
    }
    return clean;
  }
  protected moderationResult(
    clean: Buffer,
  ): Promise<DetectModerationLabelsResponse> {
    const scanner = new Rekognition({
      ...this.options,
      region: process.env.AWS_REKOGNITION_REGION || this.options.region,
    });
    return scanner
      .detectModerationLabels({ Image: { Bytes: clean }, MinConfidence: 60 });
  }
  async putApproved(key: string, bytes: Buffer) {
    return this.s3
      .putObject({
        Bucket: this.bucketFor(key),
        Key: key,
        Body: bytes,
        ContentType: 'image/jpeg',
        ContentDisposition: 'inline',
        ServerSideEncryption: 'AES256',
        CacheControl: /^(vault|chat)\//.test(key) ? 'private, no-store' : 'private, max-age=120',
      });
  }
  async putPreview(key: string, bytes: Buffer) {
    await this.ensurePrivate(this.bucketFor(key));
    return this.s3.putObject({
      Bucket: this.bucketFor(key), Key: key, Body: bytes,
      ContentType: 'image/jpeg', ContentDisposition: 'inline',
      ServerSideEncryption: 'AES256', CacheControl: 'public, max-age=86400, immutable',
    });
  }
  async getSignedURL(Key: string, Bucket?: string, expiresInSeconds = 120, noStore = false) {
    if (/^reports\//.test(Key || '')) throw new BadRequestException('Evidence cannot be signed by this path');
    if (!Key) return null;
    this.assertBucket(Bucket, Key);
    await this.ensurePrivate(this.bucketFor(Key));
    return getSignedUrl(this.s3, new GetObjectCommand({
      Bucket: this.bucketFor(Key),
      Key,
      ...(noStore ? { ResponseCacheControl: 'no-store, private' } : {}),
    }), { expiresIn: Math.max(30, Math.min(3600, Number(expiresInSeconds) || 120)) });
  }
  /** Only the case-authorized moderation service may call this signing path. */
  async signReportEvidence(key: string) {
    if (!/^reports\/[a-f\d-]+\/[a-f\d-]+\.jpg$/.test(key))
      throw new BadRequestException('Invalid evidence reference');
    await this.ensurePrivate(this.bucketFor(key));
    return getSignedUrl(this.s3, new GetObjectCommand({
      Bucket: this.bucketFor(key), Key: key, ResponseCacheControl: 'private, no-store',
      ResponseContentDisposition: 'inline',
    }), { expiresIn: 60 });
  }
  async deleteOne(Key: string, Bucket?: string) {
    if (!Key || Key.startsWith('/') || Key.includes('://'))
      throw new BadRequestException('Invalid storage key');
    this.assertBucket(Bucket, Key);
    let KeyMarker: string;
    let VersionIdMarker: string;
    do {
      const page = await this.s3
        .listObjectVersions({
          Bucket: this.bucketFor(Key),
          Prefix: Key,
          KeyMarker,
          VersionIdMarker,
        });
      const objects = [...(page.Versions || []), ...(page.DeleteMarkers || [])]
        .filter((item) => item.Key === Key)
        .map((item) => ({ Key, VersionId: item.VersionId }));
      if (objects.length) {
        const result = await this.s3
          .deleteObjects({ Bucket: this.bucketFor(Key), Delete: { Objects: objects } });
        if (result.Errors?.length)
          throw new ServiceUnavailableException(
            'Photo deletion will be retried',
          );
      }
      KeyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
      VersionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
    } while (KeyMarker);
    return this.s3.deleteObject({ Bucket: this.bucketFor(Key), Key });
  }
  async keysUnder(prefix: string) {
    const keys: string[] = [];
    let ContinuationToken: string;
    do {
      const page = await this.s3
        .listObjectsV2({
          Bucket: this.bucketFor(prefix),
          Prefix: prefix,
          ContinuationToken,
        });
      keys.push(...(page.Contents || []).map((item) => item.Key));
      ContinuationToken = page.IsTruncated
        ? page.NextContinuationToken
        : undefined;
    } while (ContinuationToken);
    return keys;
  }
  keyFromReference(value?: string): string | undefined {
    if (!value || value.includes('\\') || value.split('/').some(part => part === '..' || part === '.')) return undefined;
    if (
      /^(previews|users|temp|profile|posts|videos|avatars|groupIcon|events|groups|vault|chat|quarantine|reports|chat-media)\//.test(value) &&
      !value.includes('://')
    )
      return value;
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password)
        return undefined;
      const buckets = new Set([this.bucket, process.env.PHOTO_MEDIA_BUCKET, process.env.PHOTO_PRIVATE_BUCKET].filter(Boolean));
      for (const bucket of buckets) {
        if (url.hostname === `${bucket}.s3.amazonaws.com` || url.hostname === `${bucket}.s3.${this.options.region}.amazonaws.com`) {
          const key = decodeURIComponent(url.pathname.slice(1));
          if (bucket === this.bucketFor(key) && !key.split('/').some(part => part === '..' || part === '.') && !key.includes('\\')) return key;
        }
      }
    } catch {
      /* Foreign or invalid URLs are not storage keys. */
    }
    return undefined;
  }
  private assertBucket(bucket?: string, key = '') {
    if (bucket && bucket !== this.bucketFor(key))
      throw new BadRequestException('Invalid storage bucket');
  }
  async ensurePrivate(bucket?: string): Promise<void> {
    // Temporary operator override; object validation and moderation still run.
    if (process.env.PHOTO_VERIFY_BUCKET_SETTINGS === 'false') return;
    bucket ||= this.bucket;
    let configuration = this.configurations.get(bucket);
    if (!configuration || configuration.until < Date.now()) {
      configuration = {
        until: Date.now() + 60000,
        check: this.verifyConfiguration(bucket),
      };
      this.configurations.set(bucket, configuration);
    }
    try {
      await configuration.check;
    } catch {
      this.configurations.delete(bucket);
      throw new ServiceUnavailableException(
        'Private photo storage settings could not be verified',
      );
    }
  }
  private async verifyConfiguration(Bucket = this.bucket) {
    const [access, ownership, encryption, lifecycle, cors] = await Promise.all([
      this.s3.getPublicAccessBlock({ Bucket }),
      this.s3.getBucketOwnershipControls({ Bucket }),
      this.s3.getBucketEncryption({ Bucket }),
      this.s3.getBucketLifecycleConfiguration({ Bucket }),
      this.s3
        .getBucketCors({ Bucket })
        .catch((error) => {
          if (error.name === 'NoSuchCORSConfiguration')
            return { CORSRules: [] };
          throw error;
        }),
    ]);
    if (
      ![
        'BlockPublicAcls',
        'IgnorePublicAcls',
        'BlockPublicPolicy',
        'RestrictPublicBuckets',
      ].every((flag) => access.PublicAccessBlockConfiguration?.[flag] === true)
    )
      throw new Error('Public access is not blocked');
    if (
      !ownership.OwnershipControls?.Rules?.some(
        (rule) => rule.ObjectOwnership === 'BucketOwnerEnforced',
      )
    )
      throw new Error('ACLs must be disabled');
    if (
      !encryption.ServerSideEncryptionConfiguration?.Rules?.some((rule) =>
        ['AES256', 'aws:kms'].includes(
          rule.ApplyServerSideEncryptionByDefault?.SSEAlgorithm,
        ),
      )
    )
      throw new Error('Encryption is required');
    const rules = lifecycle.Rules || [];
    const prefix = (rule: LifecycleRule) =>
      rule.Prefix ?? (rule.Filter as any)?.Prefix;
    if (
      Bucket === this.bucketFor('temp/') && !rules.some(
        (rule) =>
          rule.Status === 'Enabled' &&
          prefix(rule) === 'temp/' &&
          rule.Expiration?.Days === 1,
      )
    )
      throw new Error('Temporary image expiry is required');
    if (
      !rules.some(
        (rule) =>
          rule.Status === 'Enabled' &&
          !prefix(rule) &&
          rule.AbortIncompleteMultipartUpload?.DaysAfterInitiation === 1,
      )
    )
      throw new Error('Incomplete upload expiry is required');
    const origins = (process.env.PHOTO_WEB_ORIGINS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    if (
      cors.CORSRules?.some((rule) =>
        rule.AllowedOrigins.some(
          (origin) => !origins.includes(origin) || origin.includes('*'),
        ),
      )
    )
      throw new Error('Unexpected browser CORS origin');
  }
}
