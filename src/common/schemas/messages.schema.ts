import { Schema, SchemaFactory, Prop } from '@nestjs/mongoose';
import mongoose, { Document } from 'mongoose';
import { UsersDocument } from './users.schema';
import { Media } from './media.schema';
import { ChatMessageDocument } from './chats.schema';

export enum EMessageBodyType {
  TEXT = 'text',
  IMAGE = 'image',
  VIDEO = 'video',
  AUDIO = 'audio',
  FILE = 'file',
}

export enum EMessageStatus {
  SENT = 'sent',
  DELIVERED = 'delivered',
  READ = 'read',
  FAILED = 'failed',
}

export type MessagesDocument = Messages & Document;

@Schema({ timestamps: true, collection: 'Messages' })
export class Messages {
  @Prop({ required: false })
  body: string;

  @Prop({
    enum: EMessageBodyType,
    required: true,
    default: EMessageBodyType.TEXT,
  })
  type: EMessageBodyType;

  @Prop({ type: [Media], required: true })
  media: Media[];

  @Prop({
    enum: EMessageStatus,
    required: true,
    default: EMessageStatus.SENT,
  })
  status: EMessageStatus;

  @Prop({
    required: true,
    ref: 'Users',
    type: mongoose.Schema.Types.ObjectId,
  })
  sender: UsersDocument | mongoose.Schema.Types.ObjectId;

  @Prop({
    required: true,
    ref: 'Chats',
    type: mongoose.Schema.Types.ObjectId,
  })
  chat: ChatMessageDocument | mongoose.Schema.Types.ObjectId;
}

export const MessagesSchema = SchemaFactory.createForClass(Messages);
