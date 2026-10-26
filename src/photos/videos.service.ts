import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Connection } from 'mongoose';
import { randomUUID } from 'crypto';
import { S3BucketService, VIDEO_TYPES, videoMaxBytes } from '../s3-bucket/s3-bucket.service';
import { PhotosService } from './photos.service';

const extension = (contentType: string) => (contentType === 'video/quicktime' ? 'mov' : 'mp4');

/**
 * Post videos: presigned POST to temp/, header verification, asynchronous
 * Rekognition moderation, then a server-side copy to videos/. Only an
 * approved video can be bound to a post, so posts never show unscanned video.
 */
@Injectable()
export class VideosService {
  private readonly logger = new Logger(VideosService.name);
  constructor(
    @InjectConnection() private readonly db: Connection,
    private readonly storage: S3BucketService,
    private readonly photos: PhotosService,
  ) {}
  private get uploads() {
    return this.db.db.collection<any>('VideoUploads');
  }
  private result(row: any) {
    return { uploadId: row._id, status: ['approved', 'attached'].includes(row.state) ? 'approved' : row.state };
  }

  async issue(owner: string, contentType: string, requestId: string, size: number) {
    await this.photos.assertActiveAccount(owner);
    await this.photos.rate(owner, 'video-issue', 10);
    if (!(VIDEO_TYPES as readonly string[]).includes(contentType)) throw new BadRequestException('Unsupported video type');
    const maxBytes = videoMaxBytes();
    if (!Number.isInteger(size) || size < 1 || size > maxBytes)
      throw new BadRequestException(`Choose a video smaller than ${Math.floor(maxBytes / 1048576)} MB`);
    let intent = await this.uploads.findOne({ owner, requestId });
    if (intent && intent.contentType !== contentType) throw new ConflictException('Upload request has changed');
    if (!intent) {
      const maximum = Math.min(100, Math.max(1, Number(process.env.VIDEO_MAX_PER_USER) || 20));
      if ((await this.uploads.countDocuments({ owner })) >= maximum)
        throw new ConflictException('Video limit reached. Delete a video post before uploading another.');
      const _id = randomUUID();
      intent = {
        _id, owner, requestId, contentType, declaredSize: size, state: 'pending',
        tempKey: `temp/${owner}/${randomUUID()}.${extension(contentType)}`,
        createdAt: new Date(), expiresAt: new Date(Date.now() + 300000),
      };
      try {
        await this.uploads.insertOne(intent);
      } catch (error) {
        if (error.code !== 11000) throw error;
        intent = await this.uploads.findOne({ owner, requestId });
        if (!intent) throw new ConflictException('Upload request has changed');
      }
    }
    if (intent.state !== 'pending') return this.result(intent);
    if (intent.expiresAt <= new Date()) throw new ConflictException('Upload expired; start a new upload');
    const signed = await this.storage.presign(intent.tempKey, contentType,
      Math.floor((intent.expiresAt.getTime() - Date.now()) / 1000), maxBytes);
    return { uploadId: intent._id, status: 'pending', ...signed, expiresAt: intent.expiresAt, maxBytes };
  }

  /** Verifies the uploaded object and starts its moderation scan. Idempotent. */
  async confirm(owner: string, id: string) {
    await this.photos.assertActiveAccount(owner);
    await this.photos.rate(owner, 'video-confirm', 30);
    const row = await this.uploads.findOne({ _id: id, owner });
    if (!row) throw new NotFoundException('Upload not found');
    if (row.state !== 'pending') return this.status(owner, id);
    if (!row.tempKey.startsWith(`temp/${owner}/`)) throw new BadRequestException('Invalid upload owner');
    const { size, etag } = await this.storage.verifyVideo(row.tempKey, row.contentType);
    if (size !== row.declaredSize) throw new BadRequestException('Uploaded video size does not match');
    const claim = await this.uploads.updateOne({ _id: id, owner, state: 'pending' },
      { $set: { state: 'scanning', size, etag, scanStartedAt: new Date() } });
    if (!claim.modifiedCount) return this.status(owner, id);
    let jobId: string | null;
    try {
      jobId = await this.storage.startVideoModeration(row.tempKey);
    } catch (error) {
      await this.uploads.updateOne({ _id: id, state: 'scanning' }, { $set: { state: 'pending' } });
      throw error;
    }
    if (jobId === null) return this.approve({ ...row, size, etag });
    await this.uploads.updateOne({ _id: id, state: 'scanning' }, { $set: { jobId } });
    return { uploadId: id, status: 'scanning' };
  }

  /** Clients poll this while a scan runs; the scan result is read on demand. */
  async status(owner: string, id: string) {
    const row = await this.uploads.findOne({ _id: id, owner });
    if (!row) throw new NotFoundException('Upload not found');
    if (row.state === 'rejected') throw new UnprocessableEntityException('Video did not pass moderation');
    if (row.state !== 'scanning' || !row.jobId) return this.result(row);
    await this.photos.rate(owner, 'video-status', 60);
    const scan = await this.storage.videoModerationResult(row.jobId);
    if (scan === 'pending') return { uploadId: id, status: 'scanning' };
    if (scan === 'rejected') {
      await this.uploads.updateOne({ _id: id, state: 'scanning' }, { $set: { state: 'rejected', rejectedAt: new Date() } });
      await this.photos.enqueue([row.tempKey]);
      throw new UnprocessableEntityException('Video did not pass moderation');
    }
    return this.approve(row);
  }

  private async approve(row: any) {
    let key = row.finalKey;
    if (!key) {
      key = `videos/${row.owner}/${randomUUID()}.${extension(row.contentType)}`;
      await this.uploads.updateOne({ _id: row._id, finalKey: { $exists: false } }, { $set: { finalKey: key } });
      key = (await this.uploads.findOne({ _id: row._id })).finalKey;
    }
    // Durable cleanup exists before the write; an approved row keeps it alive.
    await this.photos.enqueue([key], new Date(Date.now() + 600000), true);
    await this.photos.assertActiveAccount(row.owner);
    await this.storage.copyVideo(row.tempKey, key, row.contentType, row.etag);
    const committed = await this.uploads.updateOne({ _id: row._id, state: 'scanning' },
      { $set: { state: 'approved', key, approvedAt: new Date() } });
    if (!committed.modifiedCount) return this.result(await this.uploads.findOne({ _id: row._id }));
    await this.photos.enqueue([row.tempKey], new Date(Date.now() + 60000));
    return { uploadId: row._id, status: 'approved' };
  }

  /** Claim approved videos for exactly one post. Retries with the same ref are idempotent. */
  async bind(owner: string, ids: string[], ref: string) {
    if (!/^post:[a-f\d]{24}$/.test(ref)) throw new BadRequestException('Invalid resource context');
    if (!Array.isArray(ids) || ids.length > 1 || new Set(ids).size !== ids.length)
      throw new BadRequestException('A post can include one video');
    const videos: any[] = [];
    for (const id of ids) {
      const changed = await this.uploads.findOneAndUpdate(
        { _id: id, owner, $or: [{ state: 'approved' }, { state: 'attached', ref }] },
        { $set: { state: 'attached', ref } },
        { returnDocument: 'after' },
      );
      const row = (changed as any)?.value !== undefined ? (changed as any).value : changed;
      if (!row?.key) throw new BadRequestException('Video must be approved and belong to this account');
      videos.push({ videoId: id, storageKey: row.key, contentType: row.contentType, size: row.size, status: 'active' });
    }
    return videos;
  }

  /** Delete every video bound to `ref` except the kept IDs. */
  async release(owner: string, ref: string, keep: string[] = []) {
    const rows = await this.uploads.find({ owner, ref, _id: { $nin: keep } }).toArray();
    for (const row of rows) await this.remove(row);
  }

  async deleteUnattached(owner: string, id: string) {
    await this.photos.assertActiveAccount(owner);
    const row = await this.uploads.findOne({ _id: id, owner, state: { $ne: 'attached' } });
    if (!row) throw new NotFoundException('Unattached video not found');
    await this.remove(row);
  }

  private async remove(row: any) {
    // Persist deletion jobs first; the row is then dropped so it frees quota
    // and no longer keeps the objects alive.
    await this.photos.enqueue([row.tempKey, row.finalKey, row.key]);
    await this.uploads.deleteOne({ _id: row._id });
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async cleanup() {
    try {
      const stale = await this.uploads.find({ $or: [
        { state: 'pending', expiresAt: { $lt: new Date(Date.now() - 600000) } },
        { state: 'scanning', scanStartedAt: { $lt: new Date(Date.now() - 6 * 3600000) } },
        { state: 'approved', approvedAt: { $lt: new Date(Date.now() - 86400000) } },
        { state: 'rejected', rejectedAt: { $lt: new Date(Date.now() - 3600000) } },
      ] }).limit(100).toArray();
      for (const row of stale) await this.remove(row);
    } catch {
      this.logger.warn('Video cleanup pending retry');
    }
  }
}
