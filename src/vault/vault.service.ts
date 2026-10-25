import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit, UnprocessableEntityException, UnsupportedMediaTypeException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createHash, randomUUID } from 'crypto';
import { PhotosService } from '../photos/photos.service';
import { allocateKey, storedKey } from '../s3-bucket/storage-layout';
import { S3BucketService, videoMaxBytes } from '../s3-bucket/s3-bucket.service';

type UploadInput = { id: string; hidden: boolean; order: number; updatedAt: number;
  kind?: 'photo' | 'video'; contentType?: 'video/mp4' | 'video/quicktime'; size?: number; md5?: string };
const videoExtension = (contentType: string) => (contentType === 'video/quicktime' ? 'mov' : 'mp4');

@Injectable()
export class VaultService implements OnModuleInit {
  private processing = 0;
  constructor(@InjectConnection() private readonly db: Connection, private readonly storage: S3BucketService, private readonly photos: PhotosService) {}
  private get rows() { return this.db.db.collection<any>('VaultPhotos'); }
  private get tombstones() { return this.db.db.collection<any>('VaultTombstones'); }
  async onModuleInit() {
    // Photo indexes are managed centrally only with PHOTO_STORAGE_INDEXES=apply.
  }

  private async guard(owner: string, action: string, max = 60) {
    await this.photos.assertActiveAccount(owner); await this.photos.rate(owner, `vault:${action}`, max);
  }
  private stamp(value: number) {
    if (value > Date.now() + 300_000) throw new BadRequestException('Device clock is too far ahead. Correct it before syncing.');
    return value;
  }
  private present(row: any) {
    return { id: row.id, s3Key: row.deletedAt || row.state !== 'approved' ? null : storedKey(row) ?? null, sha256: row.sha256 ?? '', size: row.size ?? 0,
      status: row.state === 'rejected' ? 'rejected' : row.state === 'approved' ? 'approved' : 'local', hidden: row.hidden ? 1 : 0,
      sortOrder: row.order ?? 0, createdAt: row.createdAt, updatedAt: row.updatedAt, deletedAt: row.deletedAt ?? null,
      kind: row.kind === 'video' ? 'video' : 'photo' };
  }
  async issue(owner: string, upload: UploadInput) {
    await this.guard(owner, 'upload', 20); this.stamp(upload.updatedAt);
    const { kind = 'photo', contentType, size, md5, ...input } = upload;
    const video = kind === 'video';
    if (video && size > videoMaxBytes()) throw new BadRequestException(`Choose a video smaller than ${Math.floor(videoMaxBytes() / 1048576)} MB`);
    if (await this.tombstones.findOne({ owner, id: input.id })) throw new ConflictException('Photo was deleted');
    let row = await this.rows.findOne({ owner, id: input.id });
    if (row && (row.kind === 'video') !== video) throw new ConflictException('Vault item type has changed');
    if (!row && video) {
      const videos = Math.min(100, Math.max(1, Number(process.env.VAULT_MAX_VIDEOS) || 20));
      if (await this.rows.countDocuments({ owner, kind: 'video', state: { $ne: 'deleting' } }) >= videos)
        throw new ConflictException('Vault video limit reached');
    }
    if (!row) {
      const maximum = Math.min(100, Math.max(1, Number(process.env.VAULT_MAX_PHOTOS) || 50));
      for (let slot = 0; slot < maximum; slot++) {
        try {
          const allocation = allocateKey({ ownerId: owner, resourceType: 'vault', resourceId: randomUUID() });
          const resourceId = allocation.objectId;
          const finalKey = video ? `vault/${owner}/${randomUUID()}.${videoExtension(contentType)}` : allocation.key;
          const tempKey = video ? `temp/${owner}/${resourceId}.${videoExtension(contentType)}`
            : allocateKey({ ownerId: owner, resourceType: 'temp', resourceId }).key;
          const candidate = { ownerId: owner, resourceType: 'temp', resourceId, serverPhotoId: resourceId, s3Key: tempKey, finalKey,
            status: 'pending', storageLayoutVersion: 1, contentType: video ? contentType : 'image/jpeg', storageKeyUniqueEligible: true, _id: `${owner}:${input.id}`, owner, ...input, slot, state: 'pending',
            ...(video ? { kind: 'video', size, md5 } : {}),
            tempKey, createdAt: Date.now(), expiresAt: new Date(Date.now() + 300000) };
          await this.rows.insertOne(candidate); row = candidate; break;
        } catch (error) { if (error.code !== 11000) throw error; row = await this.rows.findOne({ owner, id: input.id }); if (row) break; }
      }
      if (!row) throw new ConflictException('Vault photo limit reached');
    }
    // Recheck tombstone after the quota reservation: delete always wins a concurrent add.
    if (await this.tombstones.findOne({ owner, id: input.id })) { await this.rows.updateOne({ _id: row._id }, { $set: { state: 'deleting', status: 'deleting', deleteAfter: new Date(Date.now() + 600000) } }); throw new ConflictException('Photo was deleted'); }
    if (row.state === 'approved' || row.state === 'rejected') return { status: row.state, photo: this.present(row) };
    if (row.state === 'deleting') throw new ConflictException('Photo was deleted');
    if (row.state === 'scanning') return { status: 'scanning' };
    if (row.state === 'processing' && row.leaseUntil > new Date()) throw new ConflictException('Photo processing');
    const expiresAt = new Date(Date.now() + 300000);
    const reserved = await this.rows.updateOne({ _id: row._id, state: { $in: ['pending', 'processing'] }, $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lt: new Date() } }] },
      { $set: { expiresAt, state: 'pending' }, $unset: { token: '', leaseUntil: '' } });
    if (!reserved.matchedCount) throw new ConflictException('Photo processing');
    return { status: 'pending', ...(await this.storage.presign(row.tempKey, row.kind === 'video' ? row.contentType : 'image/jpeg', 300,
      row.kind === 'video' ? videoMaxBytes() : undefined)) };
  }
  async confirm(owner: string, id: string) {
    await this.guard(owner, 'confirm', 30);
    const dead = await this.tombstones.findOne({ owner, id }); if (dead) return this.present(dead);
    const row = await this.rows.findOne({ owner, id }); if (!row) throw new NotFoundException('Photo not found');
    if (row.state === 'approved') return this.present(row);
    if (row.state === 'rejected') throw new UnprocessableEntityException('Photo did not pass moderation');
    if (row.kind === 'video') return this.confirmVideo(owner, row);
    if (this.processing >= 2) throw new ConflictException('Image processing is busy');
    const token = randomUUID();
    let key = row.finalKey;
    if (!key) {
      const allocation = allocateKey({ ownerId: owner, resourceType: 'vault', resourceId: randomUUID() });
      await this.rows.updateOne({ _id: row._id, finalKey: { $exists: false } }, { $set: { finalKey: allocation.key, serverPhotoId: allocation.objectId } });
      const reserved = await this.rows.findOne({ _id: row._id });
      key = reserved.finalKey; row.serverPhotoId = reserved.serverPhotoId;
    }
    const claim = await this.rows.updateOne({ _id: row._id, state: 'pending', expiresAt: { $gt: new Date() } }, { $set: { state: 'processing', status: 'processing', token, processingKey: key, leaseUntil: new Date(Date.now() + 180000) } });
    if (!claim.modifiedCount) throw new ConflictException('Upload expired or processing');
    this.processing++;
    try {
      // Durable cleanup exists before a write; inUse protects an approved vault record.
      await this.photos.enqueue([key], new Date(Date.now() + 600000), true);
      const input = await this.storage.readVerified(row.tempKey, 'image/jpeg');
      let clean: Buffer;
      try { clean = await this.storage.sanitizeAndModerate(input); }
      catch (error) {
        if (error instanceof UnsupportedMediaTypeException) {
          await this.rows.updateOne({ _id: row._id, token, state: 'processing' }, { $set: { state: 'rejected', status: 'rejected' }, $unset: { token: '', leaseUntil: '' } });
          await this.photos.enqueue([row.tempKey], new Date(row.expiresAt.getTime() + 60000));
          throw new UnprocessableEntityException('Photo did not pass moderation or safe image validation');
        }
        throw error;
      }
      await this.photos.assertActiveAccount(owner);
      if (await this.tombstones.findOne({ owner, id })) throw new ConflictException('Photo was deleted');
      await this.storage.putApproved(key, clean);
      const fields = { state: 'approved', status: 'approved', ownerId: owner, resourceType: 'vault', resourceId: row.serverPhotoId || id, storageLayoutVersion: row.storageLayoutVersion || 1, contentType: 'image/jpeg', key, s3Key: key, size: clean.length, sha256: createHash('sha256').update(clean).digest('hex') };
      const commit = await this.rows.updateOne({ _id: row._id, state: 'processing', token }, { $set: fields, $unset: { token: '', leaseUntil: '', processingKey: '' } });
      if (!commit.modifiedCount) throw new ConflictException('Photo changed');
      await this.photos.enqueue([row.tempKey], new Date(row.expiresAt.getTime() + 60000));
      return this.present({ ...row, ...fields });
    } catch (error) {
      await this.rows.updateOne({ _id: row._id, state: 'processing', token }, { $set: { state: 'pending', status: 'pending' }, $unset: { token: '', leaseUntil: '' } });
      throw error;
    } finally { this.processing--; }
  }
  /** Videos are verified by header and scanned asynchronously; clients re-confirm until done. */
  private async confirmVideo(owner: string, row: any) {
    const processing = () => ({ ...this.present(row), processing: true });
    if (row.state === 'scanning') {
      if (!row.jobId) return processing();
      const scan = await this.storage.videoModerationResult(row.jobId);
      if (scan === 'pending') return processing();
      if (scan === 'rejected') {
        await this.rows.updateOne({ _id: row._id, state: 'scanning' }, { $set: { state: 'rejected', status: 'rejected' } });
        await this.photos.enqueue([row.tempKey]);
        throw new UnprocessableEntityException('Video did not pass moderation');
      }
      return this.approveVideo(owner, row);
    }
    if (row.state !== 'pending' || row.expiresAt.getTime() + 1800000 < Date.now()) throw new ConflictException('Upload expired or processing');
    const { size, etag } = await this.storage.verifyVideo(row.tempKey, row.contentType);
    if (size !== row.size) throw new BadRequestException('Uploaded video size does not match');
    const claim = await this.rows.updateOne({ _id: row._id, state: 'pending' }, { $set: { state: 'scanning', status: 'scanning', etag, scanStartedAt: new Date() } });
    if (!claim.modifiedCount) throw new ConflictException('Video processing');
    let jobId: string | null;
    try { jobId = await this.storage.startVideoModeration(row.tempKey); }
    catch (error) {
      await this.rows.updateOne({ _id: row._id, state: 'scanning' }, { $set: { state: 'pending', status: 'pending' } });
      throw error;
    }
    if (jobId === null) return this.approveVideo(owner, { ...row, etag });
    await this.rows.updateOne({ _id: row._id, state: 'scanning' }, { $set: { jobId } });
    return processing();
  }
  private async approveVideo(owner: string, row: any) {
    if (await this.tombstones.findOne({ owner, id: row.id })) throw new ConflictException('Photo was deleted');
    const key = row.finalKey;
    await this.photos.enqueue([key], new Date(Date.now() + 600000), true);
    await this.photos.assertActiveAccount(owner);
    await this.storage.copyVideo(row.tempKey, key, row.contentType, row.etag);
    const fields = { state: 'approved', status: 'approved', ownerId: owner, resourceType: 'vault', resourceId: row.serverPhotoId || row.id,
      key, s3Key: key, sha256: `md5:${row.md5}`, size: row.size, contentType: row.contentType };
    const commit = await this.rows.updateOne({ _id: row._id, state: 'scanning' }, { $set: fields, $unset: { jobId: '' } });
    if (!commit.modifiedCount) throw new ConflictException('Photo changed');
    await this.photos.enqueue([row.tempKey], new Date(Date.now() + 60000));
    return this.present({ ...row, ...fields });
  }
  async changes(owner: string, cursor: string) {
    await this.guard(owner, 'changes', 60);
    // Full, bounded metadata reconciliation, resumable by UUID. It deliberately replays
    // unchanged rows, so concurrent writes cannot be lost at a timestamp boundary.
    const filter = { owner, ...(cursor ? { id: { $gt: cursor } } : {}) };
    const live = await this.rows.find({ ...filter, state: { $in: ['approved', 'rejected'] } }).sort({ id: 1 }).limit(101).toArray();
    const dead = await this.tombstones.find(filter).sort({ id: 1 }).limit(101).toArray();
    const merged = new Map(live.map(row => [row.id, row])); dead.forEach(row => merged.set(row.id, row));
    const ordered: any[] = [...merged.values()].sort((a: any, b: any) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return { items: ordered.slice(0, 100).map(row => this.present(row)), cursor: ordered.length > 100 ? ordered[99].id : null };
  }
  async download(owner: string, id: string) {
    await this.guard(owner, 'download');
    if (await this.tombstones.findOne({ owner, id })) throw new NotFoundException('Photo not found');
    const row = await this.rows.findOne({ owner, id, state: 'approved' });
    const key = row && storedKey(row);
    const legacyPrefix = key?.startsWith(`users/${owner}/vault/${id}/`) && /\/[0-9a-f-]{36}\.jpg$/.test(key);
    const canonicalPrefix = key?.startsWith(`vault/${owner}/`) &&
      (row.kind === 'video' ? /^vault\/[^/]+\/[0-9a-f-]{36}\.(mp4|mov)$/ : /^vault\/[^/]+\/[0-9a-f-]{36}\.jpg$/).test(key);
    // Owner/id were selected by the existing dedicated route; no role bypass.
    if (!row || !key || !(legacyPrefix || canonicalPrefix) ||
        (row.ownerId && row.ownerId !== owner) ||
        (row.resourceType && row.resourceType !== 'vault') ||
        (row.resourceId && row.resourceId !== (row.serverPhotoId || id)) ||
        (row.s3Key && row.key && row.s3Key !== row.key)) throw new NotFoundException('Photo not found');
    return { url: await this.storage.getSignedURL(key, undefined, 120, true), photo: this.present(row) };
  }
  async edit(owner: string, id: string, input: { hidden?: boolean; order?: number; updatedAt: number }) {
    await this.guard(owner, 'edit'); this.stamp(input.updatedAt);
    const dead = await this.tombstones.findOne({ owner, id }); if (dead) return this.present(dead);
    const fields: any = { updatedAt: input.updatedAt };
    if (input.hidden !== undefined) fields.hidden = input.hidden;
    if (input.order !== undefined) fields.order = input.order;
    await this.rows.updateOne({ owner, id, state: 'approved', updatedAt: { $lt: input.updatedAt } }, { $set: fields });
    const row = await this.rows.findOne({ owner, id, state: 'approved' }); if (!row) throw new NotFoundException('Photo not found');
    return this.present(row);
  }
  async remove(owner: string, id: string, updatedAt: number) {
    await this.guard(owner, 'delete'); this.stamp(updatedAt);
    // Tombstone before changing/deleting the live row. A replayed upload cannot recreate it.
    const now = Date.now();
    await this.tombstones.updateOne({ _id: `${owner}:${id}` }, { $setOnInsert: { owner, id, deletedAt: now, createdAt: now, updatedAt: Math.max(now, updatedAt), hidden: true } }, { upsert: true });
    const row = await this.rows.findOne({ owner, id });
    if (row) {
      // Wait beyond every outstanding POST/processing lease before final deletion.
      const deleteAfter = new Date(Math.max(row.state === 'processing' ? now + 300000 : now, row.expiresAt?.getTime() + 60000 || now, row.leaseUntil?.getTime() + 60000 || now));
      await this.rows.updateOne({ owner, id }, { $set: { state: 'deleting', status: 'deleting', deletedAt: now, deleteAfter }, $unset: { token: '' } });
      await this.cleanup();
    }
    return { deleted: true };
  }
  @Cron(CronExpression.EVERY_MINUTE)
  async cleanup() {
    const rows = await this.rows.find({ state: 'deleting', deleteAfter: { $lte: new Date() } }).limit(100).toArray();
    for (const row of rows) {
      try {
        // Delete all object versions via the existing storage implementation.
        for (const key of [row.tempKey, row.key, row.processingKey].filter(Boolean)) await this.storage.deleteOne(key);
        await this.rows.deleteOne({ _id: row._id, state: 'deleting' });
      } catch { /* Durable deleting row stays present for the next worker pass. */ }
    }
  }
}
