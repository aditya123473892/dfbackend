import {
  BadRequestException,
  ForbiddenException,
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

@Injectable()
export class ChatService {
  private readonly uploadWindows = new Map<string, number[]>();

  constructor(
    @InjectModel(ChatMessage.name) private readonly chatMessageModel: Model<ChatMessageDocument>,
    @InjectModel(Users.name) private readonly usersModel: Model<UsersDocument>,
    @InjectModel(Group.name) private readonly groupModel: Model<GroupDocument>,
    @InjectModel(ChatMediaAudit.name) private readonly auditModel: Model<ChatMediaAuditDocument>,
    private readonly s3BucketService: S3BucketService,
  ) {}

  async updateUserStatus(userId: string, isOnline: boolean): Promise<void> {
    if (!ObjectId.isValid(userId)) return;
    await this.usersModel.findByIdAndUpdate(userId, { isOnline, lastSeen: new Date() });
  }

  async getUserById(userId: string) {
    return ObjectId.isValid(userId) ? this.usersModel.findById(userId) : null;
  }

  async assertCanSendDirect(_actorId: string, receiverId: string) {
    if (!ObjectId.isValid(receiverId) || !(await this.usersModel.exists({ _id: receiverId }))) {
      throw new NotFoundException('Conversation not found');
    }
    return true;
  }

  async assertGroupMember(actorId: string, groupId: string) {
    if (!ObjectId.isValid(groupId)) throw new NotFoundException('Conversation not found');
    const group = await this.groupModel.exists({ _id: groupId, members: new Types.ObjectId(actorId) });
    if (!group) throw new ForbiddenException('Group membership required');
    return true;
  }

  async saveTextMessage(data: { sender: string; receiver?: string; groupId?: string; message?: string; type?: string }) {
    if (!data.message?.trim()) throw new BadRequestException('Message cannot be empty');
    const saved = await new this.chatMessageModel({ ...data, message: data.message.trim(), type: data.type || 'text' }).save();
    return this.toClientMessage(saved);
  }

  async createMediaMessage(actorId: string, dto: CreateChatMessageDto, files: Express.Multer.File[] = []) {
    if (!!dto.receiver === !!dto.groupId) throw new BadRequestException('Specify one receiver or groupId');
    if (!dto.message?.trim() && files.length === 0) throw new BadRequestException('A message or attachment is required');
    if (dto.groupId) await this.assertGroupMember(actorId, dto.groupId);
    else await this.assertCanSendDirect(actorId, dto.receiver);
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
    const saved = await new this.chatMessageModel({
      sender: actorId, receiver: dto.receiver, groupId: dto.groupId,
      message: dto.message?.trim(), media: uploaded, type: files.length ? 'media' : 'text',
    }).save();
    for (const media of (saved as any).media || []) {
      await this.audit(actorId, ChatMediaAuditAction.UPLOADED, saved, media, { mimetype: media.mimetype, size: media.size });
    }
    return this.toClientMessage(saved);
  }

  async getChatHistory(actorId: string, otherUserId: string) {
    await this.assertCanSendDirect(actorId, otherUserId);
    const messages = await this.chatMessageModel.find({
      $or: [{ sender: actorId, receiver: otherUserId }, { sender: otherUserId, receiver: actorId }],
    }).sort({ sentAt: 1 });
    return messages.map((message) => this.toClientMessage(message));
  }

  async getChatGroupHistory(actorId: string, groupId: string) {
    await this.assertGroupMember(actorId, groupId);
    const messages = await this.chatMessageModel.find({ groupId }).populate({
      path: 'sender', select: 'username displayname avatar firstName lastName',
    }).sort({ sentAt: 1 });
    return messages.map((message) => this.toClientMessage(message));
  }

  async getUnreadMessageCount(actorId: string) {
    return this.chatMessageModel.find({ receiver: actorId, isRead: false });
  }

  async markMessagesAsRead(actorId: string, otherUserId: string) {
    await this.assertCanSendDirect(actorId, otherUserId);
    await this.chatMessageModel.updateMany({ sender: otherUserId, receiver: actorId, isRead: false }, { isRead: true });
    return this.getUnreadMessageCount(actorId);
  }

  async updateMessage(messageId: string, actorId: string, newMessage: string) {
    const message = await this.findOwnedMessage(messageId, actorId);
    message.message = newMessage?.trim();
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
    const url = await this.s3BucketService.getSignedURL(storageKey, undefined, expiresIn);
    if (!url) throw new NotFoundException('Media not found');
    await this.audit(actorId, ChatMediaAuditAction.ACCESS_URL_ISSUED, message, media, { expiresIn });
    return { url, expiresIn };
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
      filter = { groupId: query.groupId, 'media.0': { $exists: true } };
    } else {
      await this.assertCanSendDirect(actorId, query.receiver);
      filter = {
        $or: [{ sender: actorId, receiver: query.receiver }, { sender: query.receiver, receiver: actorId }],
        'media.0': { $exists: true },
      };
    }
    const messages = await this.chatMessageModel.find(filter).sort({ sentAt: -1 });
    return messages.flatMap((message: any) => {
      const safe = this.toClientMessage(message);
      return (safe.media || []).map((media) => ({ ...media, messageId: safe._id, sender: safe.sender, sentAt: safe.sentAt }));
    });
  }

  async countMessagesToday(userId: string, date: Date): Promise<number> {
    return this.chatMessageModel.countDocuments({ sender: userId, createdAt: { $gte: date, $lt: new Date(date.getTime() + 86400000) } });
  }

  private async findAuthorizedMessage(messageId: string, actorId: string, includeStorageKey = false) {
    if (!ObjectId.isValid(messageId)) throw new NotFoundException('Message not found');
    let finder: any = this.chatMessageModel.findById(messageId);
    if (includeStorageKey) finder = finder.select('+media.storageKey');
    const message = await finder;
    if (!message) throw new NotFoundException('Message not found');
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
