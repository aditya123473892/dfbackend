import { BlockService } from '../user-blocks/block.service';
import { bsonIds, referenceId } from '../user-blocks/block-context';
import { preserveMutation } from '../reports/preservation';
import { restrictedResource } from '../reports/restricted-content';
import {
  BadRequestException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash, randomUUID } from 'crypto';
import { ObjectId } from 'mongodb';
import { Model, Types } from 'mongoose';
import {
  ChatMessage,
  ChatMessageDocument,
} from '../common/schemas/chats.schema';
import { Users, UsersDocument } from 'src/common/schemas';
import { Group, GroupDocument } from 'src/common/schemas/group-chat.schema';
import {
  ChatMediaAudit,
  ChatMediaAuditAction,
  ChatMediaAuditDocument,
} from 'src/common/schemas/chat-media-audit.schema';
import { ChatMediaStatus } from 'src/common/schemas/media.schema';
import { S3BucketService } from 'src/s3-bucket/s3-bucket.service';
import { PhotosService } from '../photos/photos.service';
import {
  ChatMediaQueryDto,
  CreateChatMessageDto,
} from './dto/create-chat-message.dto';

const DEFAULT_ALLOWED_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/webm',
  'video/quicktime',
];
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
};

export function hasValidMediaSignature(
  mimetype: string,
  buffer: Buffer,
): boolean {
  if (!buffer || buffer.length < 12) return false;
  if (mimetype === 'image/jpeg')
    return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mimetype === 'image/png')
    return buffer
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimetype === 'image/gif')
    return ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString());
  if (mimetype === 'image/webp')
    return (
      buffer.subarray(0, 4).toString() === 'RIFF' &&
      buffer.subarray(8, 12).toString() === 'WEBP'
    );
  if (mimetype === 'video/webm')
    return buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (mimetype === 'video/mp4' || mimetype === 'video/quicktime')
    return buffer.subarray(4, 8).toString() === 'ftyp';
  return false;
}

@Injectable()
export class ChatService {
  private readonly uploadWindows = new Map<string, number[]>();

  constructor(
    @InjectModel(ChatMessage.name)
    private readonly chatMessageModel: Model<ChatMessageDocument>,
    @InjectModel(Users.name) private readonly usersModel: Model<UsersDocument>,
    @InjectModel(Group.name) private readonly groupModel: Model<GroupDocument>,
    @InjectModel(ChatMediaAudit.name)
    private readonly auditModel: Model<ChatMediaAuditDocument>,
    private readonly s3BucketService: S3BucketService,
    private readonly photos: PhotosService = undefined,
    private readonly blocks: BlockService,
  ) {}

  async updateUserStatus(userId: string, isOnline: boolean): Promise<void> {
    if (!ObjectId.isValid(userId)) return;
    await this.usersModel.findByIdAndUpdate(userId, {
      isOnline,
      lastSeen: new Date(),
    });
  }

  async getUserById(userId: string) {
    return ObjectId.isValid(userId) ? this.usersModel.findById(userId) : null;
  }

  async assertCanSendDirect(actorId: string, receiverId: string) {
    if (await restrictedResource(this.chatMessageModel.db, 'Users', receiverId) || await restrictedResource(this.chatMessageModel.db, 'Users', actorId))
      throw new NotFoundException('Conversation not found');
    await this.blocks.assertVisible(
      actorId,
      receiverId,
      'Conversation not found',
    );
    if (
      !ObjectId.isValid(receiverId) ||
      !(await this.usersModel.exists({ _id: receiverId }))
    ) {
      throw new NotFoundException('Conversation not found');
    }
    return true;
  }

  async assertGroupMember(actorId: string, groupId: string) {
    if (!ObjectId.isValid(groupId))
      throw new NotFoundException('Conversation not found');
    const group = await this.groupModel.exists({
      _id: groupId,
      members: new Types.ObjectId(actorId),
    });
    if (!group) throw new ForbiddenException('Group membership required');
    return true;
  }

  async saveTextMessage(data: {
    sender: string;
    receiver?: string;
    groupId?: string;
    message?: string;
    type?: string;
  }) {
    if (data.groupId) await this.assertGroupMember(data.sender, data.groupId);
    else await this.assertCanSendDirect(data.sender, data.receiver);
    if (!data.message?.trim())
      throw new BadRequestException('Message cannot be empty');
    const saved = await new this.chatMessageModel({
      ...data,
      message: data.message.trim(),
      type: data.type || 'text',
    }).save();
    return this.toClientMessage(saved);
  }

  async createMediaMessage(
    actorId: string,
    dto: CreateChatMessageDto,
    files: Express.Multer.File[] = [],
  ) {
    if (files.length)
      throw new UnsupportedMediaTypeException('Use direct S3 photo uploads');
    if (!!dto.receiver === !!dto.groupId)
      throw new BadRequestException('Specify one receiver or groupId');
    const ids = dto.photoIds || [];
    const restricted = dto.viewOnce === true || dto.viewDurationSeconds != null;
    if (
      dto.viewDurationSeconds != null &&
      ![3, 10, 30, 60].includes(dto.viewDurationSeconds)
    )
      throw new BadRequestException('Invalid photo viewing timer');
    if (
      dto.ttlSeconds != null &&
      ![30, 300, 3600, 86400, 604800].includes(dto.ttlSeconds)
    )
      throw new BadRequestException('Invalid message timer');
    if (restricted && (dto.groupId || ids.length !== 1))
      throw new BadRequestException(
        'View-once messages require one photo and a direct recipient',
      );
    if (!dto.message?.trim() && !ids.length)
      throw new BadRequestException('A message or attachment is required');
    if (dto.groupId) await this.assertGroupMember(actorId, dto.groupId);
    else await this.assertCanSendDirect(actorId, dto.receiver);
    if (ids.length && !dto.clientId)
      throw new BadRequestException('clientId is required for photo messages');
    const target = dto.groupId
      ? `group:${dto.groupId}`
      : `direct:${[actorId, dto.receiver].sort().join('-')}`;
    const conversationId = createHash('sha256')
      .update(target)
      .digest('hex')
      .slice(0, 32);
    const id = dto.clientId
      ? await this.photos.reserveChatMessage(actorId, dto.clientId, target)
      : new Types.ObjectId().toString();
    const existing = await this.chatMessageModel.findOne({
      _id: id,
      sender: actorId,
    });
    if (existing) return this.toClientMessage(existing);
    const expiresAt = dto.ttlSeconds
      ? new Date(Date.now() + dto.ttlSeconds * 1000)
      : this.resolveExpiry(dto.expiresAt);
    let uploaded: any[];
    try {
      uploaded = ids.length
        ? await this.photos.bind(actorId, ids, `chat:${id}`, {
            ownerId: actorId,
            resourceType: 'chat',
            resourceId: id,
            conversationId,
            messageId: id,
          })
        : [];
    } catch (error) {
      await this.photos.failedChatSend(actorId, ids, `chat:${id}`);
      throw error;
    }
    uploaded.forEach((media) => (media.expiresAt = expiresAt));
    let saved: any;
    try {
      if (dto.groupId) await this.assertGroupMember(actorId, dto.groupId);
      else await this.assertCanSendDirect(actorId, dto.receiver);
      saved = await new this.chatMessageModel({
        _id: id,
        sender: actorId,
        receiver: dto.receiver,
        groupId: dto.groupId,
        message: dto.message?.trim(),
        media: uploaded,
        viewOnce: restricted,
        viewDurationSeconds: dto.viewDurationSeconds,
        expiresAt: dto.ttlSeconds ? expiresAt : undefined,
        type: ids.length ? 'media' : 'text',
      }).save();
    } catch (error) {
      if (error.code !== 11000) {
        await this.photos.failedChatSend(actorId, ids, `chat:${id}`);
        throw error;
      }
      saved = await this.chatMessageModel.findOne({ _id: id, sender: actorId });
    }
    for (const media of (saved as any).media || []) {
      await this.audit(actorId, ChatMediaAuditAction.UPLOADED, saved, media, {
        mimetype: media.mimetype,
        size: media.size,
      });
    }
    return this.toClientMessage(saved);
  }

  async getChatHistory(actorId: string, otherUserId: string) {
    await this.assertCanSendDirect(actorId, otherUserId);
    const messages = await this.chatMessageModel
      .find({
        $and: [
          { $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] },
        ],
        $or: [
          { sender: referenceId(actorId), receiver: referenceId(otherUserId) },
          { sender: referenceId(otherUserId), receiver: referenceId(actorId) },
        ],
      })
      .sort({ sentAt: 1 });
    return messages.map((message) => this.toClientMessage(message));
  }

  async getChatGroupHistory(actorId: string, groupId: string) {
    await this.assertGroupMember(actorId, groupId);
    const messages = await this.chatMessageModel
      .find({
        groupId: referenceId(groupId),
        $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
      })
      .sort({ sentAt: 1 });
    const ids = new Set(await this.blocks.ids(actorId, true));
    const senders = await this.usersModel
      .find({
        _id: {
          $in: messages.map((message) => String(message.sender)),
          $nin: [...ids],
        },
      })
      .select('username displayname avatar firstName lastName');
    return messages.map((message) => ({
      ...this.toClientMessage(message),
      ...(ids.has(String(message.sender)) ? { message: '', media: [] } : {}),
      sender:
        senders.find((user) => String(user._id) === String(message.sender)) ||
        String(message.sender),
      blockedSender: ids.has(String(message.sender)),
    }));
  }

  async getUnreadMessageCount(actorId: string) {
    return this.chatMessageModel.find({
      receiver: referenceId(actorId),
      sender: { $nin: bsonIds(await this.blocks.ids(actorId, true)) },
      isRead: false,
      $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
    });
  }

  async markMessagesAsRead(actorId: string, otherUserId: string) {
    await this.assertCanSendDirect(actorId, otherUserId);
    await this.chatMessageModel.updateMany(
      {
        sender: referenceId(otherUserId),
        receiver: referenceId(actorId),
        isRead: false,
      },
      { isRead: true },
    );
    return this.getUnreadMessageCount(actorId);
  }

  async updateMessage(messageId: string, actorId: string, newMessage: string) {
    const message = await this.findOwnedMessage(messageId, actorId);
    message.message = newMessage?.trim();
    return this.toClientMessage(await message.save());
  }

  async deleteMessage(messageId: string, actorId: string) {
    return preserveMutation(this.chatMessageModel.db, [`ChatMessages:${messageId}`], () => this.deleteUnheldMessage(messageId, actorId), () => this.findOwnedMessage(messageId, actorId, true));
  }
  private async deleteUnheldMessage(messageId: string, actorId: string) {
    const message = await this.findOwnedMessage(messageId, actorId, true);
    const deleted = this.toClientMessage(message);
    for (const media of (message as any).media || []) {
      const key = media.storageKey || media.filename;
      if (key) await this.photos.enqueue([key]);
      await this.audit(actorId, ChatMediaAuditAction.DELETED, message, media);
    }
    await this.photos.release(actorId, `chat:${message._id}`);
    await this.chatMessageModel.deleteOne({ _id: message._id });
    return deleted;
  }

  async getMediaAccessUrl(actorId: string, messageId: string, mediaId: string) {
    const message = await this.findAuthorizedMessage(messageId, actorId, true);
    if (message.viewOnce || message.viewDurationSeconds)
      throw new ForbiddenException(
        'Restricted photos must use the single-opening viewer',
      );
    const media = ((message as any).media || []).find(
      (item, index) => this.mediaPublicId(message, item, index) === mediaId,
    );
    if (!media) throw new NotFoundException('Media not found');
    if ((media.status || ChatMediaStatus.ACTIVE) !== ChatMediaStatus.ACTIVE) {
      await this.audit(
        actorId,
        ChatMediaAuditAction.ACCESS_DENIED,
        message,
        media,
        { reason: media.status || 'unavailable' },
      );
      throw new NotFoundException('Media not found');
    }
    if (media.expiresAt && new Date(media.expiresAt) <= new Date()) {
      await this.audit(actorId, ChatMediaAuditAction.EXPIRED, message, media);
      throw new NotFoundException('Media expired');
    }
    const storageKey = media.storageKey || media.filename;
    if (!storageKey) throw new NotFoundException('Media not found');
    const expiresIn = this.urlTtl;
    const url = await this.photos.accessUrl(storageKey, expiresIn, {
      ownerId: String(message.sender),
      resourceType: 'chat',
      resourceId: String(message._id),
      requester: actorId,
      messageId: String(message._id),
      conversationId: createHash('sha256')
        .update(
          message.groupId
            ? `group:${message.groupId}`
            : `direct:${[String(message.sender), String(message.receiver)].sort().join('-')}`,
        )
        .digest('hex')
        .slice(0, 32),
    });
    if (!url) throw new NotFoundException('Media not found');
    await this.audit(
      actorId,
      ChatMediaAuditAction.ACCESS_URL_ISSUED,
      message,
      media,
      { expiresIn },
    );
    // Audit persistence may wait on I/O; authorize again before delivering a URL.
    await this.findAuthorizedMessage(messageId, actorId, true);
    return { url, expiresIn };
  }

  async openRestrictedPhoto(
    actorId: string,
    messageId: string,
    mediaId: string,
  ) {
    const message = await this.findAuthorizedMessage(messageId, actorId, true);
    if (!message.viewOnce && !message.viewDurationSeconds)
      throw new BadRequestException('This photo has unlimited views');
    if (message.groupId || String(message.receiver) !== actorId)
      throw new ForbiddenException('Only the recipient can open this photo');
    if (message.viewedAt) throw new GoneException('Photo already opened');
    const media = ((message as any).media || []).find(
      (item, index) => this.mediaPublicId(message, item, index) === mediaId,
    );
    if (
      !media ||
      (media.status && media.status !== ChatMediaStatus.ACTIVE) ||
      (media.expiresAt && new Date(media.expiresAt) <= new Date())
    )
      throw new GoneException('Photo unavailable or expired');
    if (media.mimetype !== 'image/jpeg')
      throw new BadRequestException('Only photos are supported');
    const key = media.storageKey || media.filename;
    if (!key) throw new NotFoundException('Photo not found');
    const bytes = await this.photos.readChatPhoto(key, {
      ownerId: String(message.sender),
      resourceType: 'chat',
      resourceId: String(message._id),
      requester: actorId,
      messageId: String(message._id),
      conversationId: createHash('sha256')
        .update(`direct:${[String(message.sender), actorId].sort().join('-')}`)
        .digest('hex')
        .slice(0, 32),
    });
    // Bytes are already in server memory: storage failures leave the photo unopened.
    // The conditional update grants exactly one response, including concurrent devices.
    const viewedAt = new Date();
    const expiresAt = new Date(
      viewedAt.getTime() + (message.viewDurationSeconds || 0) * 1000,
    );
    const claimed = await this.chatMessageModel.findOneAndUpdate(
      {
        // Preserve the stored BSON type for both legacy ObjectId and string recipients.
        _id: message._id,
        receiver: message.receiver,
        viewedAt: null,
        $or: [{ expiresAt: null }, { expiresAt: { $gt: viewedAt } }],
        media: {
          $elemMatch: {
            _id: media._id,
            status: { $nin: ['revoked', 'quarantined'] },
            $or: [{ expiresAt: null }, { expiresAt: { $gt: viewedAt } }],
          },
        },
      },
      { $set: { viewedAt, 'media.$[].expiresAt': expiresAt } },
      { new: true },
    );
    await this.blocks.assertVisible(
      String(message.sender),
      String(message.receiver),
      'Message not found',
    );
    if (!claimed)
      throw new GoneException('Photo already opened or unavailable');
    return {
      dataUri: `data:image/jpeg;base64,${bytes.toString('base64')}`,
      message: this.toClientMessage(claimed),
    };
  }

  async revokeMedia(actorId: string, messageId: string, mediaId: string) {
    return preserveMutation(this.chatMessageModel.db, [`ChatMessages:${messageId}`], () => this.revokeUnheldMedia(actorId, messageId, mediaId), () => this.findOwnedMessage(messageId, actorId, true));
  }
  private async revokeUnheldMedia(actorId: string, messageId: string, mediaId: string) {
    const message = await this.findOwnedMessage(messageId, actorId, true);
    const media = ((message as any).media || []).find(
      (item, index) => this.mediaPublicId(message, item, index) === mediaId,
    );
    if (!media) throw new NotFoundException('Media not found');
    await this.photos.enqueue([media.storageKey || media.filename]);
    media.status = ChatMediaStatus.REVOKED;
    media.revokedAt = new Date();
    await message.save();
    await this.audit(actorId, ChatMediaAuditAction.REVOKED, message, media);
    return this.toClientMessage(message);
  }

  async updateMediaExpiration(
    actorId: string,
    messageId: string,
    mediaId: string,
    expiresAt?: string,
  ) {
    return preserveMutation(this.chatMessageModel.db, [`ChatMessages:${messageId}`], () => this.updateUnheldMediaExpiration(actorId, messageId, mediaId, expiresAt), () => this.findOwnedMessage(messageId, actorId, true));
  }
  private async updateUnheldMediaExpiration(actorId: string, messageId: string, mediaId: string, expiresAt?: string) {
    const message = await this.findOwnedMessage(messageId, actorId, true);
    const media = ((message as any).media || []).find(
      (item, index) => this.mediaPublicId(message, item, index) === mediaId,
    );
    if (!media) throw new NotFoundException('Media not found');
    if ((media.status || ChatMediaStatus.ACTIVE) !== ChatMediaStatus.ACTIVE) {
      throw new NotFoundException('Media not found');
    }
    media.expiresAt = this.resolveExpiry(expiresAt) || undefined;
    await message.save();
    return this.toClientMessage(message);
  }

  async listConversationMedia(actorId: string, query: ChatMediaQueryDto) {
    if (!!query.receiver === !!query.groupId)
      throw new BadRequestException('Specify one receiver or groupId');
    let filter: any;
    if (query.groupId) {
      await this.assertGroupMember(actorId, query.groupId);
      filter = {
        groupId: referenceId(query.groupId),
        sender: { $nin: bsonIds(await this.blocks.ids(actorId, true)) },
        'media.0': { $exists: true },
      };
    } else {
      await this.assertCanSendDirect(actorId, query.receiver);
      filter = {
        $or: [
          {
            sender: referenceId(actorId),
            receiver: referenceId(query.receiver),
          },
          {
            sender: referenceId(query.receiver),
            receiver: referenceId(actorId),
          },
        ],
        'media.0': { $exists: true },
      };
    }
    const messages = await this.chatMessageModel
      .find(filter)
      .sort({ sentAt: -1 });
    return messages.flatMap((message: any) => {
      const safe = this.toClientMessage(message);
      if (safe.viewOnce || safe.viewDurationSeconds) return [];
      return (safe.media || []).map((media) => ({
        ...media,
        messageId: safe._id,
        sender: safe.sender,
        sentAt: safe.sentAt,
      }));
    });
  }

  async countMessagesToday(userId: string, date: Date): Promise<number> {
    return this.chatMessageModel.countDocuments({
      sender: userId,
      createdAt: { $gte: date, $lt: new Date(date.getTime() + 86400000) },
    });
  }

  private async findAuthorizedMessage(
    messageId: string,
    actorId: string,
    includeStorageKey = false,
  ) {
    if (!ObjectId.isValid(messageId))
      throw new NotFoundException('Message not found');
    let finder: any = this.chatMessageModel.findById(messageId);
    if (includeStorageKey) finder = finder.select('+media.storageKey');
    const message = await finder;
    if (!message) throw new NotFoundException('Message not found');
    try {
      if (message.groupId)
        await this.assertGroupMember(actorId, String(message.groupId));
      else if (
        String(message.sender) !== actorId &&
        String(message.receiver) !== actorId
      )
        throw new NotFoundException('Message not found');
    } catch (_error) {
      await this.audit(actorId, ChatMediaAuditAction.ACCESS_DENIED, message);
      throw new NotFoundException('Message not found');
    }
    if (!message.groupId)
      await this.blocks.assertVisible(
        String(message.sender),
        String(message.receiver),
        'Message not found',
      );
    if (includeStorageKey && message.groupId)
      await this.blocks.assertVisible(
        actorId,
        String(message.sender),
        'Media not found',
      );
    if (message.expiresAt && message.expiresAt <= new Date())
      throw new GoneException('Message expired');
    return message;
  }

  private async findOwnedMessage(
    messageId: string,
    actorId: string,
    includeStorageKey = false,
  ) {
    const message = await this.findAuthorizedMessage(
      messageId,
      actorId,
      includeStorageKey,
    );
    if (String(message.sender) !== actorId)
      throw new ForbiddenException('Only the sender can change this message');
    return message;
  }

  private resolveExpiry(value?: string): Date | undefined {
    let expiry: Date | undefined;
    if (value) expiry = new Date(value);
    else {
      const hours = Number(process.env.CHAT_MEDIA_DEFAULT_EXPIRY_HOURS || 0);
      if (hours > 0) expiry = new Date(Date.now() + hours * 3600000);
    }
    if (expiry && (!Number.isFinite(expiry.getTime()) || expiry <= new Date()))
      throw new BadRequestException('expiresAt must be in the future');
    return expiry;
  }

  private sanitizeFilename(filename: string): string {
    const leaf = (filename || 'attachment').split(/[\\/]/).pop();
    return leaf
      .normalize('NFKC')
      .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_')
      .slice(0, 180);
  }

  async canDeliverMessage(message: any) {
    return !await restrictedResource(this.chatMessageModel.db, 'ChatMessages', String(message._id), String(message.sender?._id || message.sender), message.groupId ? String(message.groupId) : undefined);
  }
  private toClientMessage(message: any): any {
    const source = message?.toObject ? message.toObject() : { ...message };
    source.media = (source.media || []).map((media: any, index: number) => ({
      _id: this.mediaPublicId(source, media, index),
      originalname: media.originalname,
      mimetype: media.mimetype,
      size: media.size,
      checksum: media.checksum,
      status: media.status || ChatMediaStatus.ACTIVE,
      expiresAt: media.expiresAt,
      revokedAt: media.revokedAt,
      legacy: !media.storageKey && !!media.filename,
    }));
    return source;
  }

  private mediaPublicId(message: any, media: any, index: number): string {
    // New records always have a checksum; storageKey may be hidden by Mongoose
    // on ordinary history queries. Legacy records have neither, and Mongoose
    // can synthesize a non-stable subdocument _id while hydrating them.
    if (media._id && (media.storageKey || media.checksum))
      return String(media._id);
    return createHash('sha256')
      .update(
        `${message._id}:${media.filename || media.originalname || index}:${index}`,
      )
      .digest('hex')
      .slice(0, 24);
  }

  private async audit(
    actorId: string,
    action: ChatMediaAuditAction,
    message?: any,
    media?: any,
    metadata?: Record<string, string | number | boolean>,
  ) {
    await this.auditModel.create({
      actor: actorId,
      messageId: message?._id,
      mediaId: media?._id,
      conversationId: message?.groupId || message?.receiver || message?.sender,
      action,
      metadata,
    });
  }

  private get maxFileSize() {
    return Number(process.env.CHAT_MEDIA_MAX_FILE_SIZE || 25 * 1024 * 1024);
  }
  private get maxAttachments() {
    return Number(process.env.CHAT_MEDIA_MAX_ATTACHMENTS || 5);
  }
  private get urlTtl() {
    return Math.min(
      300,
      Math.max(60, Number(process.env.CHAT_MEDIA_URL_TTL_SECONDS || 120)),
    );
  }
}
