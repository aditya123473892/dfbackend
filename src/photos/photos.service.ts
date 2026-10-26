import { blockContext, bsonIds, pairBlocked, referenceId } from '../user-blocks/block-context';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Connection, Types } from 'mongoose';
import { createHash, randomUUID } from 'crypto';
import { allocateKey, bindingFromRef, matchesBinding, ResourceContext, storedKey } from '../s3-bucket/storage-layout';
import { storageIndexes } from './storage-indexes';
import { hasPreservationHold, preservationGate, preserveMutation } from '../reports/preservation';
import { protectLastRoot } from '../users/role-policy';
import { recordReportAccess } from '../reports/evidence-reader';
import { restrictedResource } from '../reports/restricted-content';
import { publicProfile } from '../users/public-profile';
import { canReadPost } from '../posts/post-access';
import { Subject } from 'rxjs';
import { S3BucketService } from '../s3-bucket/s3-bucket.service';
import { MediaService, originalUrlSeconds } from './media.service';
import { PostMapper, isMappedPostImage, isPremium } from '../posts/post.mapper';

@Injectable()
export class PhotosService implements OnModuleInit {
  readonly accountDeletion$ = new Subject<string>();
  private readonly logger = new Logger(PhotosService.name);
  private processing = 0;
  constructor(
    @InjectConnection() private readonly db: Connection,
    private readonly storage: S3BucketService,
  ) {}
  private get uploads() {
    return this.db.db.collection<any>('PhotoUploads');
  }
  private get limits() {
    return this.db.db.collection<any>('PhotoRateLimits');
  }
  private get jobs() {
    return this.db.db.collection<any>('PhotoDeletionJobs');
  }
  private get purges() {
    return this.db.db.collection<any>('AccountPurges');
  }
  private get videoUploads() {
    return this.db.db.collection<any>('VideoUploads');
  }
  async onModuleInit() {
    if (['apply', 'report'].includes(process.env.PHOTO_STORAGE_INDEXES)) {
      await storageIndexes(this.db, process.env.PHOTO_STORAGE_INDEXES === 'apply', (report) => this.logger.log(report));
    }
  }

  private async active(owner: string) {
    if (
      !Types.ObjectId.isValid(owner) ||
      !(await this.db.db.collection('Users').findOne({
        _id: new Types.ObjectId(owner),
        isBlocked: { $ne: true },
        deletionRequestedAt: { $exists: false },
        $or: [{ moderationSuspendedUntil: { $exists: false } }, { moderationSuspendedUntil: null }, { moderationSuspendedUntil: { $lte: new Date() } }],
      })) ||
      (await this.purges.findOne({ _id: owner }))
    )
      throw new ForbiddenException('Account is unavailable');
  }
  async rate(owner: string, action: string, maximum: number) {
    const minute = Math.floor(Date.now() / 60000);
    const _id = `${owner}:${action}:${minute}`;
    try {
      await this.limits.updateOne(
        { _id },
        {
          $inc: { count: 1 },
          $setOnInsert: { expiresAt: new Date(Date.now() + 120000) },
        },
        { upsert: true },
      );
    } catch (error) {
      if (error.code !== 11000) throw error;
      await this.limits.updateOne({ _id }, { $inc: { count: 1 } });
    }
    if ((await this.limits.findOne({ _id })).count > maximum)
      throw new HttpException('Too many photo requests', 429);
  }
  async assertActiveAccount(owner: string) {
    await this.active(owner);
  }
  private result(photo: any) {
    return { uploadId: photo._id, status: 'approved' };
  }

  async issue(owner: string, contentType: string, requestId: string) {
    await this.active(owner);
    await this.rate(owner, 'issue', 20);
    if (!['image/jpeg', 'image/webp'].includes(contentType))
      throw new BadRequestException('Unsupported image type');
    let intent = await this.uploads.findOne({ owner, requestId });
    if (intent && (intent.uploadContentType || intent.contentType) !== contentType)
      throw new ConflictException('Upload request has changed');
    if (!intent) {
      const maximum = Math.min(
        100,
        Math.max(1, Number(process.env.PHOTO_MAX_PER_USER) || 20),
      );
      for (let slot = 0; slot < maximum; slot++) {
        const _id = randomUUID();
        const candidate = {
          _id,
          owner,
          ownerId: owner, resourceType: 'temp', resourceId: _id,
          s3Key: '', status: 'pending', storageLayoutVersion: 1, storageKeyUniqueEligible: true,
          requestId,
          slot,
          contentType, uploadContentType: contentType,
          state: 'pending',
          tempKey: allocateKey({ ownerId: owner, resourceType: 'temp', resourceId: _id }).key,
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 300000),
        };
        try {
          candidate.s3Key = candidate.tempKey;
          await this.uploads.insertOne(candidate);
          intent = candidate;
          break;
        } catch (error) {
          if (error.code !== 11000) throw error;
          intent = await this.uploads.findOne({ owner, requestId });
          if (intent) break;
        }
      }
      if (!intent)
        throw new ConflictException(
          'Photo limit reached. Delete a photo before uploading another.',
        );
    }
    if (['approved', 'attached'].includes(intent.state))
      return this.result(intent);
    if (intent.state !== 'pending' || intent.expiresAt <= new Date())
      throw new ConflictException('Upload expired; start a new upload');
    const signed = await this.storage.presign(
      intent.tempKey,
      contentType,
      Math.floor((intent.expiresAt.getTime() - Date.now()) / 1000),
    );
    return {
      uploadId: intent._id,
      status: 'pending',
      ...signed,
      expiresAt: intent.expiresAt,
    };
  }

  async confirm(owner: string, id: string) {
    await this.active(owner);
    await this.rate(owner, 'confirm', 30);
    const initial = await this.uploads.findOne({ _id: id, owner });
    if (!initial) throw new NotFoundException('Upload not found');
    if (['approved', 'attached'].includes(initial.state))
      return this.result(initial);
    if (!initial.tempKey.startsWith(`temp/${owner}/`))
      throw new ForbiddenException('Invalid upload owner');
    if (this.processing >= 2)
      throw new HttpException('Image processing is busy; retry shortly', 429);
    this.processing++;
    try {
      const token = randomUUID();
      const now = new Date();
      const claim = await this.uploads.updateOne(
        {
          _id: id,
          owner,
          expiresAt: { $gt: now },
          $or: [
            { state: 'pending' },
            { state: 'processing', leaseUntil: { $lt: now } },
          ],
        },
        {
          $set: {
            state: 'processing', status: 'processing',
            token,
            leaseUntil: new Date(Date.now() + 180000),
          },
        },
      );
      if (!claim.modifiedCount)
        throw new ConflictException('Upload is processing or expired');
      const key = initial.processingKey || allocateKey({ ownerId: owner, resourceType: 'temp', resourceId: id }).key;
      const previewKey = initial.previewProcessingKey || `previews/${owner}/${randomUUID()}.jpg`;
      await this.uploads.updateOne({ _id: id, token }, { $set: { processingKey: key, previewProcessingKey: previewKey } });
      // A durable cleanup job exists before writing any output. A crash cannot orphan it.
      await this.enqueue([key, previewKey], new Date(Date.now() + 600000), true);
      try {
        const bytes = await this.storage.readVerified(
          initial.tempKey,
          initial.uploadContentType || initial.contentType,
        );
        const clean = await this.storage.sanitizeAndModerate(bytes);
        const preview = await new MediaService(this.storage).buildPreview(clean, previewKey);
        await this.active(owner);
        await this.storage.putApproved(key, clean);
        const committed = await this.uploads.updateOne(
          { _id: id, owner, state: 'processing', token },
          {
            $set: {
              state: 'approved', status: 'approved',
              key, s3Key: key, contentType: 'image/jpeg',
              size: clean.length,
              checksum: createHash('sha256').update(clean).digest('hex'),
              ...preview,
              approvedAt: new Date(),
            },
            $unset: { token: '', leaseUntil: '' },
          },
        );
        if (!committed.modifiedCount)
          throw new ConflictException('Upload processing lease changed');
        await this.enqueue(
          [initial.tempKey],
          new Date(Math.max(Date.now(), initial.expiresAt.getTime()) + 60000),
        );
        return this.result(initial);
      } catch (error) {
        await this.uploads.updateOne(
          { _id: id, token },
          { $set: { state: 'pending', status: 'pending' }, $unset: { token: '', leaseUntil: '' } },
        );
        throw error;
      }
    } finally {
      this.processing--;
    }
  }

  /** Claim each approved photo for exactly one server-selected resource. Retry uses the same resource ID. */
  async bind(owner: string, ids: string[], ref: string, trusted?: ResourceContext) {
    await this.active(owner);
    const context = trusted || bindingFromRef(owner, ref);
    if (context.ownerId !== owner || context.resourceId !== ref.split(':')[1])
      throw new BadRequestException('Invalid resource context');
    if (
      !Array.isArray(ids) ||
      ids.length > 5 ||
      new Set(ids).size !== ids.length
    )
      throw new BadRequestException('Invalid photo list');
    const media: any[] = [];
    for (const id of ids) {
      const photo = await this.uploads.findOne({
        _id: id,
        owner,
        $or: [{ state: 'approved' }, { state: 'attached', ref }],
      });
      if (!photo)
        throw new BadRequestException(
          'Photo must be approved and belong to this account',
        );
      if (photo.ref && photo.ref !== ref) throw new ConflictException('Photo is already in use');
      if (photo.state === 'attached' && !matchesBinding(photo, context))
        throw new ConflictException('Photo resource does not match');
      // Reserve the binding and immutable destination before S3. Another resource cannot steal it.
      const allocation = photo.finalKey ? { key: photo.finalKey } : allocateKey(context);
      const reserved = await this.uploads.updateOne({
        _id: id, owner, state: { $in: ['approved', 'attached'] },
        $or: [{ ref: { $exists: false } }, { ref }],
        ...(photo.finalKey ? { finalKey: photo.finalKey } : { finalKey: { $exists: false } }),
      }, { $set: { ref, finalKey: allocation.key } });
      if (!reserved.matchedCount) {
        const retry = await this.uploads.findOne({ _id: id, owner, ref });
        if (!retry?.finalKey) throw new ConflictException('Photo is already in use');
        allocation.key = retry.finalKey;
      }
      const sourceKey = storedKey(photo);
      const destination = photo.state === 'attached' ? sourceKey : allocation.key;
      if (photo.state !== 'attached' && sourceKey !== destination) {
        await this.enqueue([destination], new Date(Date.now() + 600000), true);
        await this.storage.copyPrivate(sourceKey, destination);
      }
      const update = await this.uploads.updateOne(
        {
          _id: id,
          owner,
          ref,
          $or: [{ state: 'approved' }, { state: 'attached', ref }],
        },
        { $set: { state: 'attached', status: 'attached', ref, ...context,
          key: destination, s3Key: destination, storageLayoutVersion: photo.storageLayoutVersion || 1,
          contentType: 'image/jpeg' } },
      );
      if (!update.matchedCount)
        throw new ConflictException('Photo is already in use');
      media.push({
        photoId: id, previewKey: photo.previewKey, blurhash: photo.blurhash,
        width: photo.width, height: photo.height,
        storageKey: destination,
        filename: destination,
        s3Key: destination, storageLayoutVersion: 1, contentType: 'image/jpeg', ownerId: owner, resourceType: context.resourceType, resourceId: context.resourceId,
        conversationId: context.conversationId, messageId: context.messageId,
        mimetype: 'image/jpeg',
        size: photo.size,
        checksum: photo.checksum,
        originalname: 'photo.jpg',
        status: 'active',
      });
      if (sourceKey !== destination) await this.enqueue([sourceKey], new Date(Date.now() + 600000), true);
    }
    return media;
  }
  async release(owner: string, ref: string, keep: string[] = []) {
    const old = await this.uploads
      .find({ owner, ref, state: 'attached', key: { $nin: keep } })
      .toArray();
    // Persist jobs before marking records. Retries are idempotent.
    await this.enqueue(old.flatMap((item) => [item.key, item.previewKey]));
    await this.uploads.updateMany(
      { owner, ref, state: 'attached', key: { $nin: keep } },
      { $set: { state: 'deleting', status: 'deleting' } },
    );
  }
  async retire(ref: string, keys: string[]) {
    const photos = await this.uploads.find({ ref, key: { $in: keys } }).toArray();
    await this.enqueue(photos.map((photo) => photo.previewKey));
    await this.enqueue(keys);
    await this.uploads.updateMany(
      { ref, key: { $in: keys } },
      { $set: { state: 'deleting', status: 'deleting' } },
    );
  }
  async replaceImage(
    collection: 'Users' | 'Groups' | 'Events',
    id: string,
    field: string,
    expected: any,
    next: any,
  ) {
    const result = await this.db.db
      .collection(collection)
      .updateOne(
        {
          _id: new Types.ObjectId(id),
          [field]: expected === undefined ? { $exists: false } : expected,
        },
        { $set: { [field]: next, updatedAt: new Date() } },
      );
    if (!result.matchedCount)
      throw new ConflictException('Photo changed; refresh before trying again');
    return this.db.db
      .collection(collection)
      .findOne({ _id: new Types.ObjectId(id) });
  }
  async deleteUnattached(owner: string, id: string) {
    await this.active(owner);
    await this.rate(owner, 'delete', 20);
    const photo = await this.uploads.findOne({
      _id: id,
      owner,
      state: { $in: ['pending', 'approved', 'deleting'] },
    });
    if (!photo) throw new NotFoundException('Unattached photo not found');
    const changed = await this.uploads.updateOne(
      { _id: id, owner, state: { $in: ['pending', 'approved', 'deleting'] } },
      { $set: { state: 'deleting', status: 'deleting' } },
    );
    if (!changed.matchedCount)
      throw new ConflictException('Photo is already in use');
    await this.enqueue(
      [photo.key, photo.tempKey, photo.previewKey, photo.previewProcessingKey],
      new Date(Math.max(Date.now(), photo.expiresAt.getTime()) + 60000),
    );
  }
  async enqueue(
    references: (string | undefined)[],
    dueAt = new Date(),
    onlyIfUnused = false,
  ) {
    for (const reference of references) {
      const key = this.storage.keyFromReference(reference);
      if (!key) continue;
      const _id = createHash('sha256').update(key).digest('hex');
      await this.jobs.updateOne(
        { _id },
        { $setOnInsert: { key, dueAt, attempts: 0, onlyIfUnused } },
        { upsert: true },
      );
    }
  }

  /** Context is obtained from the authorized response's resource ID, then verified against DB. */
  async present(value: any, requester?: string, inherited?: ResourceContext, adminPosts = false): Promise<any> {
    if (!value || typeof value !== 'object') return value;
    if (isMappedPostImage(value)) return value;
    if (value instanceof Date || value._bsontype || Buffer.isBuffer(value)) return value;
    if (Array.isArray(value)) return (await Promise.all(value.map(item => this.present(item, requester, inherited, adminPosts)))).filter(item => item !== null);
    let source = value.toObject ? value.toObject() : value;
    if ([source.storageKey, source.filename, source.url].some(item => typeof item === 'string' && (item.includes('/vault/') || item.startsWith('vault/')))) return null;
    let context = inherited;
    // Never infer ownership or resource type from a photo key or client metadata.
    if (source._id && Types.ObjectId.isValid(String(source._id))) {
      context = await this.responseContext(String(source._id), requester) || inherited;
    }
    if (context?.resourceType === 'post' && context.resourceId === String(source._id)) {
      const persisted = await this.db.db.collection('Posts').findOne({ _id: new Types.ObjectId(context.resourceId) });
      if (!persisted) return null;
      try {
        await this.assertPairAccess(context, adminPosts);
        if (!adminPosts) await this.active(context.ownerId);
      } catch (error) {
        if (error instanceof NotFoundException || error instanceof ForbiddenException) return null;
        throw error;
      }
      // Entitlement is freshly read from DB, never from JWT or client flags.
      const viewer = requester && Types.ObjectId.isValid(requester)
        ? await this.db.db.collection('Users').findOne({ _id: new Types.ObjectId(requester) }, { projection: { premiumUntil: 1 } }) : null;
      const ownLike = requester && Types.ObjectId.isValid(requester)
        ? await this.db.db.collection('Likes').findOne({ post: persisted._id, user: new Types.ObjectId(requester) }, { projection: { _id: 1 } }) : null;
      source = await new PostMapper().toResponse({ ...source, likeCount: (persisted.likes || []).length, likedByMe: !!ownLike, media: persisted.media || [], videos: persisted.videos || [],
        flag: persisted.flag, contentVisibility: persisted.contentVisibility || 'normal', user: source.user || persisted.user },
        { id: requester, premiumUntil: viewer?.premiumUntil, admin: adminPosts }, {
          canRead: async () => {
            try { await this.assertPairAccess(context, adminPosts); return true; }
            catch (error) { if (error instanceof NotFoundException || error instanceof ForbiddenException) return false; throw error; }
          },
          original: async image => {
            const key = this.storage.keyFromReference(image.storageKey || image.s3Key || image.filename || image.url);
            if (!key) return '';
            try { return await this.accessUrl(key, originalUrlSeconds(), context, adminPosts); }
            catch (error) {
              if (error instanceof NotFoundException || error instanceof ForbiddenException) return '';
              throw error;
            }
          },
          preview: key => new MediaService(this.storage).previewUrl(key),
          video: async (video) => {
            try { return await this.videoAccessUrl(String(video.storageKey || ''), context, adminPosts); }
            catch (error) { if (error instanceof NotFoundException || error instanceof ForbiddenException) return ''; throw error; }
          },
        });
      if (!source) return null;
    }
    if (context?.resourceType === 'profile' && context.resourceId === String(source._id) &&
        requester !== context.ownerId && !blockContext.getStore()?.bypass)
      source = publicProfile(source);
    const result: any = {};
    for (const [field, item] of Object.entries(source)) {
      if (['password', 'passwordResetToken', 'verifyEmailToken', 'storageKey', 'previewKey', 'previewProcessingKey'].includes(field)) continue;
      if (field === 'premiumUntil' && context?.resourceType === 'profile') continue;
      if (field === 's3Key' && source.filename) continue;
      if (['avatar', 'groupIcon'].includes(field)) {
        const expected = field === 'avatar' ? 'profile' : 'group';
        result[field] = context?.resourceType === expected ? await this.displayUrl(String(item || ''), context) : '';
      } else result[field] = await this.present(item, requester, context, adminPosts);
    }
    const key = source.storageKey || source.filename;
    if (key || (source.url && source.mimetype))
      result.url = context ? await this.displayUrl(key || source.url, context) : '';
    return result;
  }
  private async responseContext(id: string, requester?: string): Promise<ResourceContext | undefined> {
    for (const [collection, resourceType, ownerField] of [
      ['Users', 'profile', '_id'], ['Posts', 'post', 'user'], ['Events', 'event', 'creator'], ['Groups', 'group', 'admin'],
    ] as const) {
      const row = await this.db.db.collection(collection).findOne({ _id: new Types.ObjectId(id) });
      if (row) {
        if (requester) await recordReportAccess(this.db, requester, collection, id);
        return { ownerId: String(row[ownerField]?._id || row[ownerField]), resourceType, resourceId: id, requester };
      }
    }
  }
  async displayUrl(reference: string, context: ResourceContext) {
    if (!reference || !context || ['vault', 'chat', 'temp'].includes(context.resourceType)) return '';
    const key = this.storage.keyFromReference(reference);
    if (!key) return '';
    try { return await this.accessUrl(key, 120, context); }
    catch (error) { if (error instanceof NotFoundException || error instanceof ForbiddenException) return ''; throw error; }
  }
  async accessUrl(key: string, seconds: number, context: ResourceContext, adminPost = false) {
    if (!context || context.resourceType === 'vault' || context.resourceType === 'temp' || key.includes('/vault/') || key.startsWith('vault/'))
      throw new NotFoundException('Photo not available');
    const photo = await this.uploads.findOne({
      $or: [{ s3Key: key }, { key }], state: { $in: ['approved', 'attached'] },
    });
    if (!photo || storedKey(photo) !== key || !matchesBinding(photo, context))
      throw new NotFoundException('Photo not available');
    if (!adminPost) await this.active(context.ownerId);
    await this.assertPairAccess(context, adminPost);
    await this.assertPremiumAccess(context, adminPost);
    // No cross-request URL cache: every request rechecks resource and authorization state.
    const url = await this.storage.getSignedURL(storedKey(photo), undefined, seconds, ['post', 'chat'].includes(context.resourceType));
    await this.assertPairAccess(context, adminPost);
    await this.assertPremiumAccess(context, adminPost);
    return url;
  }

  /** Same checks as post images: bound row, pair access and premium entitlement, before and after signing. */
  async videoAccessUrl(key: string, context: ResourceContext, adminPost = false) {
    if (context?.resourceType !== 'post' || !/^videos\/[a-f\d]{24}\/[0-9a-f-]{36}\.(mp4|mov)$/.test(key))
      throw new NotFoundException('Video not available');
    const row = await this.videoUploads.findOne({ key, state: 'attached', ref: `post:${context.resourceId}`, owner: context.ownerId });
    if (!row) throw new NotFoundException('Video not available');
    if (!adminPost) await this.active(context.ownerId);
    await this.assertPairAccess(context, adminPost);
    await this.assertPremiumAccess(context, adminPost);
    const url = await this.storage.getSignedURL(key, undefined, originalUrlSeconds(), true);
    await this.assertPairAccess(context, adminPost);
    await this.assertPremiumAccess(context, adminPost);
    return url;
  }

  private async assertPremiumAccess(context: ResourceContext, adminPost: boolean) {
    if (context.resourceType !== 'post' || adminPost || context.requester === context.ownerId) return;
    const post = await this.db.db.collection('Posts').findOne({ _id: new Types.ObjectId(context.resourceId) });
    if (!post) throw new NotFoundException('Photo not available');
    if (post.contentVisibility !== 'premium') return;
    const viewer = context.requester && await this.db.db.collection<any>('Users').findOne({ _id: new Types.ObjectId(context.requester) });
    if (!isPremium(viewer)) throw new NotFoundException('Photo not available');
  }

  /** Read restricted chat photos through the API; never expose a reusable S3 URL. */
  async readChatPhoto(key: string, context: ResourceContext): Promise<Buffer> {
    if (context?.resourceType !== 'chat') throw new NotFoundException('Photo not available');
    const photo = await this.uploads.findOne({
      $or: [{ s3Key: key }, { key }], state: 'attached',
    });
    if (!photo || storedKey(photo) !== key || !matchesBinding(photo, context))
      throw new NotFoundException('Photo not available');
    await this.active(context.ownerId);
    await this.assertPairAccess(context);
    const bytes = await this.storage.readVerified(key, 'image/jpeg');
    await this.assertPairAccess(context);
    return bytes;
  }

  private async assertPairAccess(context: ResourceContext, adminPost = false) {
    if (adminPost && context.resourceType === 'post') return;
    const collection = ({ profile: 'Users', post: 'Posts', event: 'Events', group: 'Groups', chat: 'ChatMessages' })[context.resourceType];
    if (collection && await restrictedResource(this.db, collection, context.resourceId, context.ownerId))
      throw new NotFoundException('Media not found');
    if (blockContext.getStore()?.bypass) return;
    if (!context.requester) throw new NotFoundException('Photo not available');
    if (context.resourceType === 'post' &&
        !await canReadPost(this.db, context.resourceId, context.requester))
      throw new NotFoundException('Photo not available');
    if (context.resourceType === 'chat') {
      const message = await this.db.db.collection('ChatMessages').findOne({ _id: new Types.ObjectId(context.resourceId) });
      if (!message) throw new NotFoundException('Photo not available');
      const sender = String(message.sender), receiver = String(message.receiver);
      if (message.groupId) {
        if (!await this.db.db.collection('Groups').findOne({ _id: referenceId(String(message.groupId)), members: { $in: bsonIds([context.requester]) } } as any))
          throw new NotFoundException('Photo not available');
      } else if (![sender, receiver].includes(context.requester)) {
        throw new NotFoundException('Photo not available');
      }
      if (await pairBlocked(this.db, context.requester, sender) ||
          (!message.groupId && await pairBlocked(this.db, sender, receiver)))
        throw new NotFoundException('Photo not available');
    } else if (await pairBlocked(this.db, context.requester, context.ownerId)) {
      throw new NotFoundException('Photo not available');
    }
  }
  async reserveChatMessage(owner: string, requestId: string, target: string) {
    // Preserve retries of messages created before server-ID reservations were introduced.
    const legacyId = createHash('sha256').update(`chat:${owner}:${requestId}`).digest('hex').slice(0, 24);
    const legacy = await this.db.db.collection('ChatMessages').findOne({ _id: new Types.ObjectId(legacyId), sender: new Types.ObjectId(owner) });
    if (legacy) {
      const legacyTarget = legacy.groupId ? `group:${legacy.groupId}` : `direct:${[owner, String(legacy.receiver)].sort().join('-')}`;
      if (legacyTarget !== target) throw new ConflictException('Message request changed');
      return legacyId;
    }
    const _id = createHash('sha256').update(owner + ':' + requestId).digest('hex');
    const reservations = this.db.db.collection<any>('PhotoChatSends');
    await reservations.updateOne({ _id }, { $setOnInsert: { owner, target, messageId: new Types.ObjectId().toString() } }, { upsert: true });
    const row = await reservations.findOne({ _id });
    if (row.target !== target) throw new ConflictException('Message request changed');
    return row.messageId as string;
  }
  async failedChatSend(owner: string, ids: string[], ref: string) {
    for (const photo of await this.uploads.find({ owner, _id: { $in: ids }, ref, state: { $in: ['approved', 'attached'] } }).toArray()) {
      await this.enqueue([photo.tempKey, photo.key, photo.finalKey], new Date(Date.now() + 600000), true);
    }
  }

  /** Operator-only migration entry point; it is deliberately not an HTTP endpoint. */
  async importLegacy(owner: string, reference: string, ref: string) {
    const key = this.storage.keyFromReference(reference);
    if (!key)
      throw new BadRequestException(
        'Legacy object has no valid key in this bucket',
      );
    const existing = await this.uploads.findOne({
      key,
      owner,
      state: 'attached',
      ref,
    });
    if (existing) return key;
    const head = await this.storage.s3
      .headObject({ Bucket: this.storage.bucket, Key: key });
    const bytes = await this.storage.readVerified(key, head.ContentType);
    const requestId =
      'legacy-' +
      createHash('sha256')
        .update(ref + ':' + key)
        .digest('hex')
        .slice(0, 40);
    const issued: any = await this.issue(owner, head.ContentType, requestId);
    if (issued.status !== 'approved') {
      await this.storage.s3
        .putObject({
          Bucket: this.storage.bucket,
          Key: issued.fields.key,
          Body: bytes,
          ContentType: head.ContentType,
          ServerSideEncryption: 'AES256',
        });
      await this.confirm(owner, issued.uploadId);
    }
    const [photo] = await this.bind(owner, [issued.uploadId], ref);
    return photo.filename;
  }

  async requestAccountDeletion(owner: string) {
    return preservationGate(this.db, async () => {
      await this.active(owner);
      const apply = async (session?: any) => {
        await protectLastRoot(this.db, owner, session);
        // Purge scheduling and account unavailability commit together. A failed
        // write must not leave a hidden purge job counted as an available root.
        await this.purges.updateOne({ _id: owner }, {
          $setOnInsert: { requestedAt: new Date(), dueAt: new Date(Date.now() + 600000) },
        }, { upsert: true, session });
        await this.db.db.collection('Users').updateOne({ _id: new Types.ObjectId(owner) },
          { $set: { isBlocked: true, deletionRequestedAt: new Date() } }, { session });
        await this.uploads.updateMany({ owner }, { $set: { state: 'deleting', status: 'deleting' } }, { session });
      };
      if (this.db?.getClient) {
        const session = await this.db.startSession();
        try { await session.withTransaction(() => apply(session), {
          readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' },
        }); } finally { await session.endSession(); }
      } else await apply(); // In-memory test doubles only; startup requires transactions.
      this.accountDeletion$.next(owner);
    });
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async cleanup() {
    try {
      const abandoned = await this.uploads
        .find({
          $or: [
            {
              state: { $in: ['pending', 'processing'] },
              expiresAt: { $lt: new Date(Date.now() - 600000) },
            },
            {
              state: 'approved',
              approvedAt: { $lt: new Date(Date.now() - 86400000) },
            },
            { state: 'deleting' },
          ],
        })
        .limit(100)
        .toArray();
      for (const photo of abandoned) {
        await this.enqueue(
          [photo.tempKey, photo.key, photo.processingKey, photo.finalKey, photo.previewKey, photo.previewProcessingKey],
          new Date(Math.max(Date.now(), photo.expiresAt.getTime() + 60000)),
          true,
        );
        await this.uploads.updateOne(
          { _id: photo._id, state: photo.state },
          { $set: { state: 'deleting', status: 'deleting' } },
        );
      }
      // A process may die after claiming photos but before saving the resource.
      for (const photo of await this.uploads
        .find({
          state: 'attached',
          createdAt: { $lt: new Date(Date.now() - 86400000) },
        })
        .limit(100)
        .toArray()) {
        if (!(await this.inUse(photo.key))) {
          await this.enqueue([photo.key, photo.tempKey, photo.previewKey]);
          await this.uploads.updateOne(
            { _id: photo._id, state: 'attached', ref: photo.ref },
            { $set: { state: 'deleting', status: 'deleting' } },
          );
        }
      }
      // Expired/revoked chat photos are physically removed, not just hidden.
      const chats = await this.db.db
        .collection('ChatMessages')
        .find({
          media: {
            $elemMatch: {
              $or: [{ expiresAt: { $lte: new Date() } }, { status: 'revoked' }],
            },
          },
        })
        .limit(100)
        .toArray();
      for (const chat of chats)
        for (const media of chat.media || []) {
          if (
            media.status === 'revoked' ||
            (media.expiresAt && new Date(media.expiresAt) <= new Date())
          ) {
            await this.enqueue([media.storageKey || media.filename]);
            await this.uploads.updateMany(
              { key: media.storageKey || media.filename },
              { $set: { state: 'deleting', status: 'deleting' } },
            );
          }
        }
      for (const job of await this.jobs
        .find({ dueAt: { $lte: new Date() } })
        .limit(100)
        .toArray()) {
        if (
          job.onlyIfUnused &&
          ((await this.uploads.findOne({
            $or: [{ key: job.key }, { previewKey: job.key }],
            state: { $in: ['approved', 'attached'] },
          })) ||
            (await this.videoUploads.findOne({
              $or: [{ key: job.key }, { finalKey: job.key }],
              state: { $in: ['scanning', 'approved', 'attached'] },
            })))
        ) {
          await this.jobs.deleteOne({ _id: job._id });
          continue;
        }
        if (await this.inUse(job.key)) {
          await this.jobs.updateOne(
            { _id: job._id },
            { $set: { dueAt: new Date(Date.now() + 60000) } },
          );
          continue;
        }
        try {
          await preserveMutation(this.db, [`key:${job.key}`], async () => {
            await this.storage.deleteOne(job.key);
          });
          // A temp key must not free a quota slot while its approved object remains.
          await this.uploads.deleteMany({ state: 'deleting', key: job.key });
          await this.uploads.deleteMany({
            state: 'deleting',
            tempKey: job.key,
            key: { $exists: false },
          });
          await this.jobs.deleteOne({ _id: job._id });
        } catch {
          await this.jobs.updateOne(
            { _id: job._id },
            {
              $inc: { attempts: 1 },
              $set: {
                dueAt: new Date(
                  Date.now() +
                    Math.min(3600000, 60000 * 2 ** Math.min(job.attempts, 6)),
                ),
              },
            },
          );
          this.logger.warn('Photo deletion pending retry');
        }
      }
      for (const purge of await this.purges
        .find({ dueAt: { $lte: new Date() } })
        .limit(10)
        .toArray()) {
        try {
          await this.purgeAccount(purge._id);
        } catch {
          await this.purges.updateOne(
            { _id: purge._id },
            {
              $inc: { attempts: 1 },
              $set: {
                dueAt: new Date(
                  Date.now() +
                    Math.min(
                      3600000,
                      60000 * 2 ** Math.min(purge.attempts || 0, 6),
                    ),
                ),
              },
            },
          );
          this.logger.warn('Account purge pending retry');
        }
      }
    } catch {
      this.logger.warn('Photo cleanup pending retry');
    }
  }

  private async inUse(key: string) {
    if (await hasPreservationHold(this.db, [`key:${key}`])) return true;
    if (key.startsWith('previews/') && await this.uploads.findOne({ previewKey: key, state: { $in: ['approved', 'attached'] } })) return true;
    // A temp video is the moderation source until it is copied.
    if (key.startsWith('temp/') && await this.videoUploads.findOne({ tempKey: key, state: { $in: ['pending', 'scanning'] } })) return true;
    if (key.startsWith('temp/')) return !!(await this.uploads.findOne({ key, state: { $in: ['approved', 'attached'] } }));
    if (await this.db.db.collection('VaultPhotos').findOne({ key, state: { $in: ['approved', 'processing'] } })) return true;
    if (key.startsWith('videos/') && (await this.videoUploads.findOne({ key, state: { $in: ['approved', 'attached'] } }) ||
      await this.db.db.collection('Posts').findOne({ 'videos.storageKey': key, deletedAt: null }, { projection: { _id: 1 } }))) return true;
    if (await this.uploads.findOne({ $or: [{ processingKey: key }, { previewProcessingKey: key }, { finalKey: key }], state: 'processing', leaseUntil: { $gt: new Date() } })) return true;
    // Deletion and image replacement can race. An object referenced by a live
    // record must survive, even if an older mutation already enqueued it.
    const urlPattern = new RegExp(
      '/' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:\\?|$)',
    );
    const values: any = { $in: [key, urlPattern] };
    for (const [collection, filter] of [
      ['Users', { avatar: values }],
      ['Groups', { groupIcon: values }],
      [
        'Posts',
        {
          media: {
            $elemMatch: {
              $or: [
                { filename: key },
                { previewKey: key },
                { storageKey: key },
                { url: urlPattern },
              ],
            },
          },
        },
      ],
      [
        'Events',
        {
          $or: [
            { 'cover.filename': key },
            { 'cover.storageKey': key },
            { 'cover.url': urlPattern },
          ],
        },
      ],
      [
        'ChatMessages',
        {
          media: {
            $elemMatch: {
              $and: [
                {
                  $or: [
                    { filename: key },
                    { storageKey: key },
                    { url: urlPattern },
                  ],
                },
                { status: { $nin: ['revoked', 'quarantined'] } },
                {
                  $or: [
                    { expiresAt: { $exists: false } },
                    { expiresAt: null },
                    { expiresAt: { $gt: new Date() } },
                  ],
                },
              ],
            },
          },
        },
      ],
    ] as [string, any][]) {
      if (
        await this.db.db
          .collection(collection)
          .findOne({ $and: [filter, { deletedAt: null }] }, { projection: { _id: 1 } })
      )
        return true;
    }
    return false;
  }

  private async purgeAccount(owner: string) {
    return preserveMutation(this.db, [`owner:${owner}`, `Users:${owner}`], () => this.purgeUnheldAccount(owner));
  }
  private async purgeUnheldAccount(owner: string) {
    const id = new Types.ObjectId(owner);
    const users = this.db.db.collection('Users');
    await users.updateOne(
      { _id: id },
      { $set: { isBlocked: true, deletionRequestedAt: new Date() } },
    );
    const keys = new Set<string>();
    const add = (value: string) => {
      const key = this.storage.keyFromReference(value);
      if (key) keys.add(key);
    };
    const user = await users.findOne({ _id: id });
    add(user?.avatar);
    const posts = await this.db.db
      .collection('Posts')
      .find({ user: id })
      .toArray();
    const groups = await this.db.db
      .collection('Groups')
      .find({ admin: id })
      .toArray();
    const messages = await this.db.db
      .collection('ChatMessages')
      .find({
        $or: [
          { sender: id },
          { receiver: id },
          { groupId: { $in: groups.map((group) => group._id) } },
        ],
      })
      .toArray();
    const events = await this.db.db
      .collection('Events')
      .find({ creator: id })
      .toArray();
    for (const row of [
      ...posts,
      ...messages.filter((message) => String(message.sender) === owner),
    ])
      for (const media of row.media || [])
        add(media.storageKey || media.filename || media.url);
    groups.forEach((group) => add(group.groupIcon));
    events.forEach((event) => add(event.cover?.filename || event.cover?.url));
    for (const photo of await this.uploads.find({ owner }).toArray()) {
      add(photo.key);
      add(photo.tempKey);
      add(photo.processingKey);
      add(photo.previewKey);
      add(photo.previewProcessingKey);
      add(photo.finalKey);
    }
    for (const video of await this.videoUploads.find({ owner }).toArray()) {
      add(video.tempKey);
      add(video.finalKey);
      add(video.key);
    }
    for (const prefix of [`previews/${owner}/`, `users/${owner}/`, `temp/${owner}/`, `profile/${owner}/`, `posts/${owner}/`, `videos/${owner}/`, `vault/${owner}/`])
      (await this.storage.keysUnder(prefix)).forEach(add);
    // Any failure keeps the account blocked and the durable job present.
    for (const key of keys) {
      if (await hasPreservationHold(this.db, [`key:${key}`])) {
        await this.enqueue([key]);
      } else await this.storage.deleteOne(key);
    }
    await this.uploads.deleteMany({ owner });
    await this.videoUploads.deleteMany({ owner });
    await this.db.db.collection('VaultPhotos').deleteMany({ owner });
    await this.db.db.collection('VaultTombstones').deleteMany({ owner });
    await this.db.db.collection('Posts').deleteMany({ user: id });
    // Photos authored by other users in removed conversations also get durable
    // cleanup jobs; another live reference protects shared legacy objects.
    for (const message of messages) {
      await this.retire(
        `chat:${message._id}`,
        (message.media || []).map(
          (media) => media.storageKey || media.filename || media.url,
        ),
      );
    }
    await this.db.db
      .collection('ChatMessages')
      .deleteMany({ _id: { $in: messages.map((message) => message._id) } });
    await this.db.db.collection('Groups').deleteMany({ admin: id });
    await this.db.db
      .collection('Groups')
      .updateMany({ members: id }, { $pull: { members: id } } as any);
    await this.db.db.collection('Events').deleteMany({ creator: id });
    await this.db.db
      .collection('follows')
      .deleteMany({ $or: [{ follower: id }, { following: id }] });
    const postIds = posts.map((post) => post._id);
    const deletedComments = await this.db.db
      .collection('Comments')
      .find(
        { $or: [{ user: id }, { post: { $in: postIds } }] },
        { projection: { _id: 1 } },
      )
      .toArray();
    const deletedLikes = await this.db.db
      .collection('Likes')
      .find(
        { $or: [{ user: id }, { post: { $in: postIds } }] },
        { projection: { _id: 1 } },
      )
      .toArray();
    await this.db.db.collection('Posts').updateMany({}, {
      $pull: {
        comments: { $in: deletedComments.map((row) => row._id) },
        likes: { $in: deletedLikes.map((row) => row._id) },
      },
    } as any);
    await this.db.db
      .collection('Comments')
      .deleteMany({ _id: { $in: deletedComments.map((row) => row._id) } });
    await this.db.db
      .collection('Likes')
      .deleteMany({ _id: { $in: deletedLikes.map((row) => row._id) } });
    await this.db.db
      .collection('UserBookMark')
      .deleteMany({ $or: [{ userId: id }, { bookMarkUser: id }] });
    await this.db.db
      .collection('PostBookMark')
      .deleteMany({ $or: [{ userId: id }, { postId: { $in: postIds } }] });
    await this.db.db
      .collection('PostRequest')
      .deleteMany({ $or: [{ userId: id }, { requestedUserId: id }] });
    await this.db.db.collection('Notifications').deleteMany({ $or: [{ sender: id }, { receiver: id }] });
    await this.db.db.collection('EventMembers').deleteMany({ $or: [{ user: id }, { event: { $in: events.map((event) => event._id) } }] });
    await this.db.db.collection('UserBlocks').deleteMany({ $or: [{ blockerId: id }, { blockedId: id }] });
    await this.db.db.collection('UserEdits').deleteMany({ user: id });
    await this.db.db.collection('UserSubscriptions').deleteMany({ user: id });
    await this.db.db.collection('Payments').deleteMany({ userId: owner });
    await this.db.db.collection('Messages').deleteMany({ $or: [{ sender: id }, { chat: { $in: messages.map((message) => message._id) } }] });
    await this.db.db.collection('ReportAccess').deleteMany({ $or: [{ viewerId: owner }, { resource: { $in: [
      `Users:${owner}`, ...posts.map((post) => `Posts:${post._id}`), ...events.map((event) => `Events:${event._id}`),
    ] } }] });
    await this.db.db.collection('ReportMemberships').deleteMany({ $or: [{ userId: owner }, { groupId: { $in: groups.map((group) => String(group._id)) } }] });
    await users.deleteOne({ _id: id });
    await this.purges.deleteOne({ _id: owner });
  }
}
