import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { Users } from './users.schema';
import { Media } from './media.schema';
import { Group } from './group-chat.schema';

export type ChatMessageDocument = ChatMessage & Document;

@Schema({ timestamps: true, collection: 'ChatMessages' })
export class ChatMessage {
  @Prop({ type: Types.ObjectId, ref: Users.name, required: true })
  sender: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: Users.name, required: false })
  receiver?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: Group.name, required: false })
  groupId?: Types.ObjectId;

  @Prop()
  message: string;

  @Prop({
    type: [Media],
    required: false,
  })
  media?: Media[];
  @Prop()
  type: string;

  @Prop({ default: false })
  isRead: boolean;

  @Prop({ default: false })
  viewOnce: boolean;

  @Prop({ type: Number })
  viewDurationSeconds?: number;

  @Prop({ type: Date })
  expiresAt?: Date;

  @Prop({ type: Date })
  viewedAt?: Date;

  @Prop({ type: Date, default: Date.now })
  sentAt: Date;
}

export const ChatMessageSchema = SchemaFactory.createForClass(ChatMessage);
