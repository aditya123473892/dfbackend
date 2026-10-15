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

  @Prop({ type: Date, default: Date.now })
  sentAt: Date;

  // Client-generated idempotency key, unique per sender. A retried send with
  // the same key returns the stored message instead of creating a duplicate.
  @Prop({ required: false })
  clientId?: string;
}

export const ChatMessageSchema = SchemaFactory.createForClass(ChatMessage);

ChatMessageSchema.index(
  { sender: 1, clientId: 1 },
  { unique: true, partialFilterExpression: { clientId: { $type: 'string' } } },
);
ChatMessageSchema.index({ sender: 1, receiver: 1, sentAt: -1 });
ChatMessageSchema.index({ receiver: 1, isRead: 1 });
ChatMessageSchema.index({ groupId: 1, sentAt: -1 });
