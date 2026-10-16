import {
  BadRequestException,
  ConflictException,
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
import { ChatMessage, ChatMessageDocument } from '../common/schemas/chats.schema';
import { Users, UsersDocument } from 'src/common/schemas';
import { Group, GroupDocument } from 'src/common/schemas/group-chat.schema';
import {
  ChatMediaAudit,
  ChatMediaAuditAction,
  ChatMediaAuditDocument,
} from 'src/common/schemas/chat-media-audit.schema';
import { ChatMediaStatus } from 'src/common/schemas/media.schema';
import { S3BucketService } from 'src/s3-bucket/s3-bucket.service';
import {
  ChatReadCursor,
  ChatReadCursorDocument,
} from 'src/common/schemas/chat-read-cursor.schema';
import { ChatMediaQueryDto, CreateChatMessageDto } from './dto/create-chat-message.dto';

const DEFAULT_ALLOWED_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'video/mp4', 'video/webm', 'video/quicktime',
];
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
  'image/webp': 'webp', 'video/mp4': 'mp4', 'video/webm': 'webm',
  'video/quicktime': 'mov',
};

export function hasValidMediaSignature(mimetype: string, buffer: Buffer): boolean {
  if (!buffer || buffer.length < 12) return false;
  if (mimetype === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mimetype === 'image/png') return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimetype === 'image/gif') return ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString());
  if (mimetype === 'image/webp') return buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP';
  if (mimetype === 'video/webm') return buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (mimetype === 'video/mp4' || mimetype === 'video/quicktime') return buffer.subarray(4, 8).toString() === 'ftyp';
  return false;
}

export const MAX_MESSAGE_LENGTH = 10000;
export const MAX_HISTORY_PAGE = 100;
// Fields of a chat peer that other users may see. Never include username
// (the account email), phone number or account-management fields.
export const PUBLIC_USER_FIELDS = 'displayname avatar firstName lastName';
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
/** Allowed disappearing-message timers: 30 s, 5 min, 1 h, 1 day, 1 week. */
export const MESSAGE_TTL_SECONDS = [30, 300, 3600, 86400, 604800];
/** An unopened view-once item is removed after this long. */
export const VIEW_ONCE_UNOPENED_SECONDS = 14 * 86400;
const PURGE_BATCH = 200;

/**
 * Matches messages whose timer has not run out. Expired messages are hidden
 * from every read immediately; the sweeper deletes them later.
 */
export function notExpired(now = new Date()) {
  return { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] };
}
const live = (filter: any) => ({ $and: [filter, notExpired()] });

export type HistoryPage = { limit?: number; before?: string };

function isDuplicateKeyError(error: any): boolean {
  return error?.code === 11000;
}

const GROUP_ICON_URL_TTL_SECONDS = 3600;

/**
 * Query value matching an id stored either as an ObjectId or as a string.
 * ChatMessage and Group declare their id fields with `Types.ObjectId`, which
 * Mongoose treats as Mixed: earlier versions of this service stored plain
 * strings while imported data holds ObjectIds. Queries must find both.
 */
export function anyId(id: string | Types.ObjectId) {
  const text = String(id);
  return ObjectId.isValid(text) ? { $in: [text, new Types.ObjectId(text)] } : text;
}
export const toObjectId = (id: string | Types.ObjectId) => new Types.ObjectId(String(id));
export const idForms = (ids: (string | Types.ObjectId)[]) =>
  ids.flatMap((id) => [String(id), toObjectId(id)]);

/**
 * Object key of a group image. Legacy records stored only a signed URL of a
 * `groupIcon/<file>` object; the key is recovered from its path.
 */
export function groupIconStorageKey(group: { groupIconKey?: string; groupIcon?: string }) {
  if (group?.groupIconKey) return group.groupIconKey;
  if (!group?.groupIcon) return undefined;
  try {
    const leaf = decodeURIComponent(group.groupIcon.split('?')[0].split('/').pop() || '');
    return leaf ? `groupIcon/${leaf}` : undefined;
  } catch (_error) {
    return undefined;
  }
}

@Injectable()
export class ChatService {
  private readonly uploadWindows = new Map<string, number[]>();

  constructor(
    @InjectModel(ChatMessage.name) private readonly chatMessageModel: Model<ChatMessageDocument>,
    @InjectModel(Users.name) private readonly usersModel: Model<UsersDocument>,
    @InjectModel(Group.name) private readonly groupModel: Model<GroupDocument>,
    @InjectModel(ChatMediaAudit.name) private readonly auditModel: Model<ChatMediaAuditDocument>,
    private readonly s3BucketService: S3BucketService,
    @InjectModel(ChatReadCursor.name) private readonly readCursorModel?: Model<ChatReadCursorDocument>,
  ) {}

  async updateUserStatus(userId: string, isOnline: boolean): Promise<void> {
    if (!ObjectId.isValid(userId)) return;
    await this.usersModel.findByIdAndUpdate(userId, { isOnline, lastSeen: new Date() });
  }

  async getUserById(userId: string) {
    return ObjectId.isValid(userId) ? this.usersModel.findById(userId) : null;
  }

  async assertCanSendDirect(actorId: string, receiverId: string) {
    if (!ObjectId.isValid(receiverId) || !(await this.usersModel.exists({ _id: receiverId }))) {
      throw new NotFoundException('Conversation not found');
    }
    if (String(receiverId) === String(actorId)) {
      throw new BadRequestException('You cannot message yourself');
    }
    return true;
  }

  async assertGroupMember(actorId: string, groupId: string) {
    if (!ObjectId.isValid(groupId) || !ObjectId.isValid(actorId)) throw new NotFoundException('Conversation not found');
    const group = await this.groupModel.exists({ _id: groupId, members: anyId(actorId) });
    if (!group) throw new ForbiddenException('Group membership required');
    return true;
  }

  async getGroupIdsForUser(userId: string): Promise<string[]> {
    if (!ObjectId.isValid(userId)) return [];
    const groups = await this.groupModel.find({ members: anyId(userId) }).select('_id').lean();
    return groups.map((group: any) => String(group._id));
  }

  async saveTextMessage(data: { sender: string; receiver?: string; groupId?: string; message?: string; type?: string; clientId?: string; ttlSeconds?: unknown }) {
    const text = typeof data.message === 'string' ? data.message.trim() : '';
    if (!text) throw new BadRequestException('Message cannot be empty');
    if (text.length > MAX_MESSAGE_LENGTH) throw new BadRequestException(`Messages are limited to ${MAX_MESSAGE_LENGTH} characters`);
    const clientId = this.normalizeClientId(data.clientId);
    const sentAt = new Date();
    const expiresAt = this.messageExpiry(sentAt, data.ttlSeconds);
    const existing = await this.findIdempotentMessage(data.sender, clientId, data);
    if (existing) return existing;
    try {
      const saved = await new this.chatMessageModel({
        sender: toObjectId(data.sender),
        receiver: data.receiver ? toObjectId(data.receiver) : undefined,
        groupId: data.groupId ? toObjectId(data.groupId) : undefined,
        message: text, type: data.type || 'text', clientId, sentAt, expiresAt,
      }).save();
      return this.toClientMessage(saved);
    } catch (error) {
      // A concurrent retry with the same key won the insert; return its record.
      const duplicate = isDuplicateKeyError(error) && await this.findIdempotentMessage(data.sender, clientId, data);
      if (duplicate) return duplicate;
      throw error;
    }
  }

  async createMediaMessage(actorId: string, dto: CreateChatMessageDto, files: Express.Multer.File[] = []) {
    if (!!dto.receiver === !!dto.groupId) throw new BadRequestException('Specify one receiver or groupId');
    if (!dto.message?.trim() && files.length === 0) throw new BadRequestException('A message or attachment is required');
    if (dto.groupId) await this.assertGroupMember(actorId, dto.groupId);
    else await this.assertCanSendDirect(actorId, dto.receiver);
    const viewOnce = this.parseFlag(dto.viewOnce, 'viewOnce');
    if (viewOnce) {
      if (dto.groupId) throw new BadRequestException('View-once media can only be sent in direct chats');
      if (files.length !== 1) throw new BadRequestException('A view-once message must contain exactly one photo or video');
      if (dto.message?.trim()) throw new BadRequestException('View-once messages cannot include text');
    }
    const sentAt = new Date();
    const messageExpiresAt = this.messageExpiry(sentAt, dto.ttlSeconds, viewOnce);
    const clientId = this.normalizeClientId(dto.clientId);
    // Check before uploading so a retried send does not store its media twice.
    const existing = await this.findIdempotentMessage(actorId, clientId, dto);
    if (existing) return existing;
    this.assertUploadRate(actorId, files.length);
    files.forEach((file) => this.validateUpload(file));
    const expiresAt = this.resolveExpiry(dto.expiresAt);
    const uploaded: any[] = [];
    try {
      for (const file of files) {
        const storageKey = `chat-media/${randomUUID()}.${EXTENSIONS[file.mimetype]}`;
        const result = await this.s3BucketService.uploadPrivateFile(file, storageKey);
        if (!result) throw new BadRequestException('Failed to upload media');
        uploaded.push({
          storageKey,
          originalname: this.sanitizeFilename(file.originalname),
          mimetype: file.mimetype,
          size: file.size,
          checksum: createHash('sha256').update(file.buffer).digest('hex'),
          status: ChatMediaStatus.ACTIVE,
          expiresAt,
        });
      }
    } catch (error) {
      await Promise.all(uploaded.map((media) => this.s3BucketService.deleteOne(media.storageKey)));
      throw error;
    }
    let saved: any;
    try {
      saved = await new this.chatMessageModel({
        sender: toObjectId(actorId),
        receiver: dto.receiver ? toObjectId(dto.receiver) : undefined,
        groupId: dto.groupId ? toObjectId(dto.groupId) : undefined,
        message: dto.message?.trim(), media: uploaded, type: files.length ? 'media' : 'text',
        clientId, sentAt, expiresAt: messageExpiresAt,
        ...(viewOnce ? { viewOnce: true } : {}),
      }).save();
    } catch (error) {
      await Promise.all(uploaded.map((media) => this.s3BucketService.deleteOne(media.storageKey)));
      const duplicate = isDuplicateKeyError(error) && await this.findIdempotentMessage(actorId, clientId, dto);
      if (duplicate) return duplicate;
      throw error;
    }
    for (const media of (saved as any).media || []) {
      await this.audit(actorId, ChatMediaAuditAction.UPLOADED, saved, media, { mimetype: media.mimetype, size: media.size });
    }
    return this.toClientMessage(saved);
  }

  /**
   * Without `page.limit` the full history is returned (legacy clients). With a
   * limit, returns the newest `limit` messages older than message `before`,
   * still in ascending order. Fewer than `limit` rows means no older history.
   */
  async getChatHistory(actorId: string, otherUserId: string, page: HistoryPage = {}) {
    await this.assertCanSendDirect(actorId, otherUserId);
    const filter = {
      $or: [
        { sender: anyId(actorId), receiver: anyId(otherUserId) },
        { sender: anyId(otherUserId), receiver: anyId(actorId) },
      ],
    };
    if (!page.limit) {
      const messages = await this.chatMessageModel.find(live(filter)).sort({ sentAt: 1 });
      return messages.map((message) => this.toClientMessage(message));
    }
    return this.findHistoryPage(filter, page);
  }

  async getChatGroupHistory(actorId: string, groupId: string, page: HistoryPage = {}) {
    await this.assertGroupMember(actorId, groupId);
    if (!page.limit) {
      const messages = await this.chatMessageModel.find(live({ groupId: anyId(groupId) })).populate({
        path: 'sender', select: PUBLIC_USER_FIELDS,
      }).sort({ sentAt: 1 });
      return messages.map((message) => this.toClientMessage(message));
    }
    return this.findHistoryPage({ groupId: anyId(groupId) }, page, true);
  }

  async getUnreadMessageCount(actorId: string) {
    // Kept as an array of unread direct messages for compatibility; only the
    // fields clients need to count and attribute them are returned.
    return this.chatMessageModel
      .find(live({ receiver: anyId(actorId), isRead: false }))
      .select('_id sender receiver sentAt isRead');
  }

  async markMessagesAsRead(actorId: string, otherUserId: string) {
    await this.assertCanSendDirect(actorId, otherUserId);
    await this.chatMessageModel.updateMany(
      { sender: anyId(otherUserId), receiver: anyId(actorId), isRead: false },
      { isRead: true },
    );
    return this.getUnreadMessageCount(actorId);
  }

  /** Moves the member's group read cursor forward; it never moves backwards. */
  async markGroupAsRead(actorId: string, groupId: string) {
    await this.assertGroupMember(actorId, groupId);
    const now = new Date();
    await this.readCursorModel.updateOne(
      { user: new Types.ObjectId(actorId), groupId: new Types.ObjectId(groupId) },
      { $max: { lastReadAt: now } },
      { upsert: true },
    );
    return { groupId, lastReadAt: now.toISOString(), unreadCount: 0 };
  }

  /** New members start with nothing unread, rather than the group's whole backlog. */
  async initializeGroupReadCursors(groupId: string, userIds: string[]) {
    if (!this.readCursorModel || !userIds.length) return;
    const now = new Date();
    await this.readCursorModel.bulkWrite(userIds.map((userId) => ({
      updateOne: {
        filter: { user: new Types.ObjectId(userId), groupId: new Types.ObjectId(groupId) },
        update: { $max: { lastReadAt: now } },
        upsert: true,
      },
    })));
  }

  /**
   * Every direct and group conversation of the actor with its newest message
   * and unread count, most recently active first.
   */
  async getConversations(actorId: string) {
    if (!ObjectId.isValid(actorId)) throw new NotFoundException('User not found');
    const meForms = idForms([actorId]);

    // Ids may be stored as strings or ObjectIds, so they are compared as strings.
    const direct = await this.chatMessageModel.aggregate([
      { $match: live({ groupId: null, receiver: { $ne: null }, $or: [{ sender: { $in: meForms } }, { receiver: { $in: meForms } }] }) },
      { $sort: { sentAt: -1, _id: -1 } },
      {
        $addFields: {
          fromMe: { $eq: [{ $toString: '$sender' }, actorId] },
          toMe: { $eq: [{ $toString: '$receiver' }, actorId] },
        },
      },
      { $addFields: { peer: { $toString: { $cond: ['$fromMe', '$receiver', '$sender'] } } } },
      { $match: { peer: { $ne: actorId } } },
      {
        $group: {
          _id: '$peer',
          last: { $first: '$$ROOT' },
          unread: { $sum: { $cond: [{ $and: ['$toMe', { $eq: ['$isRead', false] }] }, 1, 0] } },
        },
      },
    ]);
    const peers = await this.usersModel
      .find({ _id: { $in: direct.filter((row) => ObjectId.isValid(row._id)).map((row) => toObjectId(row._id)) } })
      .select(`${PUBLIC_USER_FIELDS} isOnline lastSeen`)
      .lean();
    const peersById = new Map(peers.map((peer: any) => [String(peer._id), peer]));

    const groups = await this.groupModel
      .find({ members: anyId(actorId) })
      .select('name groupIcon groupIconKey description admin members createdAt updatedAt')
      .lean();
    const icons = await Promise.all(groups.map((group: any) => this.groupIconUrl(group)));
    const groupIds = groups.map((group: any) => group._id);
    const [groupLast, cursors] = groupIds.length
      ? await Promise.all([
          this.chatMessageModel.aggregate([
            { $match: live({ groupId: { $in: idForms(groupIds) } }) },
            { $sort: { sentAt: -1, _id: -1 } },
            { $group: { _id: { $toString: '$groupId' }, last: { $first: '$$ROOT' } } },
          ]),
          this.readCursorModel
            ? this.readCursorModel.find({ user: toObjectId(actorId), groupId: { $in: groupIds } }).lean()
            : [],
        ])
      : [[], []];
    const readAt = new Map((cursors as any[]).map((cursor) => [String(cursor.groupId), cursor.lastReadAt]));
    const groupUnread = groupIds.length
      ? await this.chatMessageModel.aggregate([
          {
            $match: live({
              sender: { $nin: meForms },
              $or: groupIds.map((id) => ({
                groupId: { $in: idForms([id]) },
                sentAt: { $gt: readAt.get(String(id)) || new Date(0) },
              })),
            }),
          },
          { $group: { _id: { $toString: '$groupId' }, count: { $sum: 1 } } },
        ])
      : [];
    const unreadByGroup = new Map(groupUnread.map((row) => [String(row._id), row.count]));
    const lastByGroup = new Map(groupLast.map((row) => [String(row._id), row.last]));

    const conversations = [
      ...direct
        .filter((row) => peersById.has(String(row._id)))
        .map((row) => ({
          id: `user:${row._id}`,
          kind: 'direct',
          peer: peersById.get(String(row._id)),
          lastMessage: this.toClientMessage(this.withoutAggregateFields(row.last)),
          unreadCount: row.unread,
          updatedAt: row.last.sentAt,
        })),
      ...groups.map((group: any, index) => {
        const last = lastByGroup.get(String(group._id));
        return {
          id: `group:${group._id}`,
          kind: 'group',
          group: {
            _id: group._id,
            name: group.name,
            groupIcon: icons[index],
            description: group.description,
            admin: group.admin,
            memberCount: group.members?.length || 0,
            createdAt: group.createdAt,
            updatedAt: group.updatedAt,
          },
          lastMessage: last ? this.toClientMessage(last) : null,
          unreadCount: unreadByGroup.get(String(group._id)) || 0,
          updatedAt: last?.sentAt || group.createdAt,
        };
      }),
    ];
    return conversations.sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }

  /** Removes a group's messages, stored media and read cursors. */
  async deleteGroupConversation(groupId: string) {
    const messages = await this.chatMessageModel
      .find({ groupId: anyId(groupId), 'media.0': { $exists: true } })
      .select('+media.storageKey');
    for (const message of messages as any[]) {
      for (const media of message.media || []) {
        const key = media.storageKey || media.filename;
        if (key) await this.s3BucketService.deleteOne(key);
      }
    }
    await this.chatMessageModel.deleteMany({ groupId: anyId(groupId) });
    await this.readCursorModel?.deleteMany({ groupId: new Types.ObjectId(groupId) });
  }

  async removeGroupReadCursors(groupId: string, userIds: string[]) {
    if (!userIds.length) return;
    await this.readCursorModel?.deleteMany({
      groupId: new Types.ObjectId(groupId),
      user: { $in: userIds.map((id) => new Types.ObjectId(id)) },
    });
  }

  async updateMessage(messageId: string, actorId: string, newMessage: string) {
    const text = typeof newMessage === 'string' ? newMessage.trim() : '';
    const message = await this.findOwnedMessage(messageId, actorId);
    if (!text && !((message as any).media || []).length) throw new BadRequestException('Message cannot be empty');
    if (text.length > MAX_MESSAGE_LENGTH) throw new BadRequestException(`Messages are limited to ${MAX_MESSAGE_LENGTH} characters`);
    message.message = text;
    return this.toClientMessage(await message.save());
  }

  async deleteMessage(messageId: string, actorId: string) {
    const message = await this.findOwnedMessage(messageId, actorId, true);
    const deleted = this.toClientMessage(message);
    for (const media of (message as any).media || []) {
      const key = media.storageKey || media.filename;
      if (key) await this.s3BucketService.deleteOne(key);
      await this.audit(actorId, ChatMediaAuditAction.DELETED, message, media);
    }
    await this.chatMessageModel.deleteOne({ _id: message._id });
    return deleted;
  }

  async getMediaAccessUrl(actorId: string, messageId: string, mediaId: string) {
    const message = await this.findAuthorizedMessage(messageId, actorId, true);
    const media = ((message as any).media || []).find((item, index) =>
      this.mediaPublicId(message, item, index) === mediaId,
    );
    if (!media) throw new NotFoundException('Media not found');
    if ((media.status || ChatMediaStatus.ACTIVE) !== ChatMediaStatus.ACTIVE) {
      await this.audit(actorId, ChatMediaAuditAction.ACCESS_DENIED, message, media, { reason: media.status || 'unavailable' });
      throw new NotFoundException('Media not found');
    }
    if (media.expiresAt && new Date(media.expiresAt) <= new Date()) {
      await this.audit(actorId, ChatMediaAuditAction.EXPIRED, message, media);
      throw new NotFoundException('Media expired');
    }
    const storageKey = media.storageKey || media.filename;
    if (!storageKey) throw new NotFoundException('Media not found');
    const expiresIn = this.urlTtl;
    // A view-once item is consumed before its URL is signed, so concurrent
    // requests cannot both obtain one.
    const opened = (message as any).viewOnce ? await this.consumeViewOnce(actorId, message, media) : null;
    let url: string | null = null;
    try {
      url = await this.s3BucketService.getSignedURL(storageKey, undefined, expiresIn);
    } finally {
      if (!url && opened) await this.chatMessageModel.updateOne({ _id: message._id, viewedAt: opened.viewedAt }, { $unset: { viewedAt: 1 } });
    }
    if (!url) throw new NotFoundException('Media not found');
    await this.audit(actorId, ChatMediaAuditAction.ACCESS_URL_ISSUED, message, media, { expiresIn });
    return opened ? { url, expiresIn, viewOnce: true, message: opened } : { url, expiresIn };
  }

  /** Marks a view-once message opened; only its recipient can, and only once. */
  private async consumeViewOnce(actorId: string, message: any, media: any) {
    if (String(message.receiver) !== String(actorId)) {
      await this.audit(actorId, ChatMediaAuditAction.ACCESS_DENIED, message, media, { reason: 'view_once_not_recipient' });
      throw new ForbiddenException('Only the recipient can open view-once media');
    }
    const updated = await this.chatMessageModel.findOneAndUpdate(
      { _id: message._id, viewOnce: true, viewedAt: null },
      { $set: { viewedAt: new Date() } },
      { new: true },
    );
    if (!updated) {
      await this.audit(actorId, ChatMediaAuditAction.ACCESS_DENIED, message, media, { reason: 'view_once_opened' });
      throw new GoneException('This view-once media was already opened');
    }
    await this.audit(actorId, ChatMediaAuditAction.VIEW_ONCE_OPENED, message, media);
    return this.toClientMessage(updated);
  }

  /**
   * Deletes messages whose timer ran out, together with their stored media.
   * Returns the removed messages so they can be broadcast as deletions.
   */
  async purgeExpiredMessages(now = new Date(), limit = PURGE_BATCH) {
    const rows = await this.chatMessageModel
      .find({ expiresAt: { $lte: now } })
      .select('+media.storageKey')
      .limit(limit);
    const purged = [];
    for (const message of rows as any[]) {
      for (const media of message.media || []) {
        const key = media.storageKey || media.filename;
        if (key) await this.s3BucketService.deleteOne(key);
        await this.audit(String(message.sender), ChatMediaAuditAction.DELETED, message, media, { reason: 'expired' });
      }
      const { deletedCount } = await this.chatMessageModel.deleteOne({ _id: message._id, expiresAt: { $lte: now } });
      if (deletedCount) purged.push(this.toClientMessage(message));
    }
    return purged;
  }

  /**
   * Deletes the stored file of view-once media once its single access URL can
   * no longer be valid. The message stays, with its media marked revoked.
   */
  async purgeOpenedViewOnceMedia(now = new Date(), limit = PURGE_BATCH) {
    const cutoff = new Date(now.getTime() - this.urlTtl * 1000);
    const rows = await this.chatMessageModel
      .find({ viewOnce: true, viewedAt: { $lte: cutoff }, 'media.status': ChatMediaStatus.ACTIVE })
      .select('+media.storageKey')
      .limit(limit);
    const purged = [];
    for (const message of rows as any[]) {
      for (const media of message.media || []) {
        const key = media.storageKey || media.filename;
        if (key) await this.s3BucketService.deleteOne(key);
        media.status = ChatMediaStatus.REVOKED;
        media.revokedAt = now;
        media.storageKey = undefined;
        media.filename = undefined;
        await this.audit(String(message.sender), ChatMediaAuditAction.DELETED, message, media, { reason: 'view_once_opened' });
      }
      purged.push(this.toClientMessage(await message.save()));
    }
    return purged;
  }

  async revokeMedia(actorId: string, messageId: string, mediaId: string) {
    const message = await this.findOwnedMessage(messageId, actorId, true);
    const media = ((message as any).media || []).find((item, index) =>
      this.mediaPublicId(message, item, index) === mediaId,
    );
    if (!media) throw new NotFoundException('Media not found');
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
    const message = await this.findOwnedMessage(messageId, actorId, true);
    const media = ((message as any).media || []).find((item, index) =>
      this.mediaPublicId(message, item, index) === mediaId,
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
    if (!!query.receiver === !!query.groupId) throw new BadRequestException('Specify one receiver or groupId');
    let filter: any;
    if (query.groupId) {
      await this.assertGroupMember(actorId, query.groupId);
      filter = { groupId: anyId(query.groupId), 'media.0': { $exists: true } };
    } else {
      await this.assertCanSendDirect(actorId, query.receiver);
      filter = {
        $or: [
          { sender: anyId(actorId), receiver: anyId(query.receiver) },
          { sender: anyId(query.receiver), receiver: anyId(actorId) },
        ],
        'media.0': { $exists: true },
      };
    }
    // View-once media is never listed in the shared media gallery.
    const messages = await this.chatMessageModel.find(live({ ...filter, viewOnce: { $ne: true } })).sort({ sentAt: -1 });
    return messages.flatMap((message: any) => {
      const safe = this.toClientMessage(message);
      return (safe.media || []).map((media) => ({ ...media, messageId: safe._id, sender: safe.sender, sentAt: safe.sentAt }));
    });
  }

  async countMessagesToday(userId: string, date: Date): Promise<number> {
    return this.chatMessageModel.countDocuments({ sender: anyId(userId), createdAt: { $gte: date, $lt: new Date(date.getTime() + 86400000) } });
  }

  /** A short-lived URL for a group image, signed at read time. */
  async groupIconUrl(group: { groupIconKey?: string; groupIcon?: string }) {
    const key = groupIconStorageKey(group);
    if (!key) return undefined;
    return (await this.s3BucketService.getSignedURL(key, undefined, GROUP_ICON_URL_TTL_SECONDS)) || undefined;
  }

  private withoutAggregateFields(message: any) {
    const { fromMe, toMe, peer, ...rest } = message;
    return rest;
  }

  /** Expiry for a disappearing message, from a timer in MESSAGE_TTL_SECONDS. */
  private messageExpiry(sentAt: Date, value: unknown, viewOnce = false): Date | undefined {
    let ttl: number | undefined;
    if (value !== undefined && value !== null && value !== '') {
      ttl = Number(value);
      if (!MESSAGE_TTL_SECONDS.includes(ttl)) {
        throw new BadRequestException(`ttlSeconds must be one of ${MESSAGE_TTL_SECONDS.join(', ')}`);
      }
    }
    // Unopened view-once media does not stay stored indefinitely.
    if (viewOnce) ttl = Math.min(ttl ?? VIEW_ONCE_UNOPENED_SECONDS, VIEW_ONCE_UNOPENED_SECONDS);
    return ttl ? new Date(sentAt.getTime() + ttl * 1000) : undefined;
  }

  private parseFlag(value: unknown, name: string): boolean {
    if (value === undefined || value === null || value === '' || value === false || value === 'false') return false;
    if (value === true || value === 'true') return true;
    throw new BadRequestException(`${name} must be a boolean`);
  }

  private normalizeClientId(value: unknown): string | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string' || !CLIENT_ID_PATTERN.test(value)) {
      throw new BadRequestException('clientId must be 8-64 letters, digits, "-" or "_"');
    }
    return value;
  }

  /** Returns the message already stored under this sender's key, if any. */
  private async findIdempotentMessage(
    senderId: string,
    clientId: string | undefined,
    target: { receiver?: string; groupId?: string },
  ) {
    if (!clientId) return null;
    const existing: any = await this.chatMessageModel.findOne({ sender: anyId(senderId), clientId });
    if (!existing) return null;
    const sameConversation = target.groupId
      ? String(existing.groupId) === String(target.groupId)
      : !existing.groupId && String(existing.receiver) === String(target.receiver);
    if (!sameConversation) throw new ConflictException('clientId was already used for another message');
    return this.toClientMessage(existing);
  }

  private async findHistoryPage(filter: any, page: HistoryPage, populateSender = false) {
    const limit = Math.min(MAX_HISTORY_PAGE, Math.max(1, Math.floor(Number(page.limit)) || 50));
    let query: any = { ...filter };
    if (page.before) {
      if (!ObjectId.isValid(page.before)) throw new BadRequestException('Invalid history cursor');
      const cursor: any = await this.chatMessageModel.findOne({ ...filter, _id: page.before }).select('sentAt');
      if (!cursor) throw new BadRequestException('Invalid history cursor');
      // (sentAt, _id) keyset so messages sharing a timestamp are never skipped.
      query = {
        $and: [filter, {
          $or: [
            { sentAt: { $lt: cursor.sentAt } },
            { sentAt: cursor.sentAt, _id: { $lt: cursor._id } },
          ],
        }],
      };
    }
    // The cursor itself may have expired since the client loaded it; only the
    // returned rows are filtered.
    let finder: any = this.chatMessageModel.find(live(query)).sort({ sentAt: -1, _id: -1 }).limit(limit);
    if (populateSender) finder = finder.populate({ path: 'sender', select: PUBLIC_USER_FIELDS });
    const rows = await finder;
    return rows.reverse().map((message) => this.toClientMessage(message));
  }

  private async findAuthorizedMessage(messageId: string, actorId: string, includeStorageKey = false) {
    if (!ObjectId.isValid(messageId)) throw new NotFoundException('Message not found');
    let finder: any = this.chatMessageModel.findById(messageId);
    if (includeStorageKey) finder = finder.select('+media.storageKey');
    const message = await finder;
    if (!message) throw new NotFoundException('Message not found');
    if (message.expiresAt && new Date(message.expiresAt) <= new Date()) throw new NotFoundException('Message not found');
    try {
      if (message.groupId) await this.assertGroupMember(actorId, String(message.groupId));
      else if (String(message.sender) !== actorId && String(message.receiver) !== actorId) throw new NotFoundException('Message not found');
    } catch (_error) {
      await this.audit(actorId, ChatMediaAuditAction.ACCESS_DENIED, message);
      throw new NotFoundException('Message not found');
    }
    return message;
  }

  private async findOwnedMessage(messageId: string, actorId: string, includeStorageKey = false) {
    const message = await this.findAuthorizedMessage(messageId, actorId, includeStorageKey);
    if (String(message.sender) !== actorId) throw new ForbiddenException('Only the sender can change this message');
    return message;
  }

  private validateUpload(file: Express.Multer.File) {
    const configured = (process.env.CHAT_MEDIA_ALLOWED_TYPES || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
    const allowedTypes = configured.length ? configured : DEFAULT_ALLOWED_TYPES;
    if (!allowedTypes.includes(file.mimetype?.toLowerCase())) throw new UnsupportedMediaTypeException(`Unsupported media type: ${file.mimetype || 'unknown'}`);
    if (file.size > this.maxFileSize) throw new PayloadTooLargeException(`Each attachment must be ${this.maxFileSize} bytes or smaller`);
    if (!hasValidMediaSignature(file.mimetype.toLowerCase(), file.buffer)) throw new UnsupportedMediaTypeException('File content does not match its declared media type');
    if (!this.scanMedia(file)) throw new UnsupportedMediaTypeException('Media failed security scanning');
  }

  // Hook for an antivirus/content-scanning provider. Override or replace this
  // before allowing uploads when a scanner is available.
  protected scanMedia(_file: Express.Multer.File): boolean { return true; }

  private assertUploadRate(actorId: string, attachmentCount: number) {
    if (attachmentCount > this.maxAttachments) throw new BadRequestException(`A message can contain at most ${this.maxAttachments} attachments`);
    if (!attachmentCount) return;
    const now = Date.now();
    const recent = (this.uploadWindows.get(actorId) || []).filter((timestamp) => timestamp > now - 60000);
    const limit = Number(process.env.CHAT_MEDIA_UPLOADS_PER_MINUTE || 20);
    if (recent.length + attachmentCount > limit) throw new PayloadTooLargeException('Media upload rate limit exceeded');
    this.uploadWindows.set(actorId, [...recent, ...Array(attachmentCount).fill(now)]);
  }

  private resolveExpiry(value?: string): Date | undefined {
    let expiry: Date | undefined;
    if (value) expiry = new Date(value);
    else {
      const hours = Number(process.env.CHAT_MEDIA_DEFAULT_EXPIRY_HOURS || 0);
      if (hours > 0) expiry = new Date(Date.now() + hours * 3600000);
    }
    if (expiry && expiry <= new Date()) throw new BadRequestException('expiresAt must be in the future');
    return expiry;
  }

  private sanitizeFilename(filename: string): string {
    const leaf = (filename || 'attachment').split(/[\\/]/).pop();
    return leaf.normalize('NFKC').replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').slice(0, 180);
  }

  private toClientMessage(message: any): any {
    const source = message?.toObject ? message.toObject() : { ...message };
    source.media = (source.media || []).map((media: any, index: number) => ({
      _id: this.mediaPublicId(source, media, index), originalname: media.originalname, mimetype: media.mimetype,
      size: media.size, checksum: media.checksum,
      status: media.status || ChatMediaStatus.ACTIVE,
      expiresAt: media.expiresAt, revokedAt: media.revokedAt,
      legacy: !media.storageKey && !!media.filename,
    }));
    return source;
  }

  private mediaPublicId(message: any, media: any, index: number): string {
    // New records always have a checksum; storageKey may be hidden by Mongoose
    // on ordinary history queries. Legacy records have neither, and Mongoose
    // can synthesize a non-stable subdocument _id while hydrating them.
    if (media._id && (media.storageKey || media.checksum)) return String(media._id);
    return createHash('sha256')
      .update(`${message._id}:${media.filename || media.originalname || index}:${index}`)
      .digest('hex')
      .slice(0, 24);
  }

  private async audit(actorId: string, action: ChatMediaAuditAction, message?: any, media?: any, metadata?: Record<string, string | number | boolean>) {
    await this.auditModel.create({
      actor: actorId, messageId: message?._id, mediaId: media?._id,
      conversationId: message?.groupId || message?.receiver || message?.sender,
      action, metadata,
    });
  }

  private get maxFileSize() { return Number(process.env.CHAT_MEDIA_MAX_FILE_SIZE || 25 * 1024 * 1024); }
  private get maxAttachments() { return Number(process.env.CHAT_MEDIA_MAX_ATTACHMENTS || 5); }
  private get urlTtl() { return Math.min(300, Math.max(60, Number(process.env.CHAT_MEDIA_URL_TTL_SECONDS || 120))); }
}
