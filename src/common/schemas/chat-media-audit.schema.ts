import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { Users } from './users.schema';
import { ChatMessage } from './chats.schema';

export type ChatMediaAuditDocument = ChatMediaAudit & Document;

export enum ChatMediaAuditAction {
  UPLOADED = 'media_uploaded',
  ACCESS_URL_ISSUED = 'media_access_url_issued',
  ACCESS_DENIED = 'media_access_denied',
  REVOKED = 'media_revoked',
  EXPIRED = 'media_expired',
  DELETED = 'media_deleted',
}

@Schema({ timestamps: true, collection: 'ChatMediaAudits' })
export class ChatMediaAudit {
  @Prop({ type: Types.ObjectId, ref: Users.name, required: true })
  actor: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: ChatMessage.name, required: false })
  messageId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: false })
  mediaId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: false })
  conversationId?: Types.ObjectId;

  @Prop({ type: String, enum: ChatMediaAuditAction, required: true })
  action: ChatMediaAuditAction;

  @Prop({ type: Object, required: false })
  metadata?: Record<string, string | number | boolean>;
}

export const ChatMediaAuditSchema =
  SchemaFactory.createForClass(ChatMediaAudit);

ChatMediaAuditSchema.index({ actor: 1, createdAt: -1 });
ChatMediaAuditSchema.index({ messageId: 1, createdAt: -1 });
