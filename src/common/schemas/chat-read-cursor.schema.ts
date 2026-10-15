import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { Document, Types } from 'mongoose';
import { Users } from './users.schema';
import { Group } from './group-chat.schema';

export type ChatReadCursorDocument = ChatReadCursor & Document;

/**
 * A member's read position in a group conversation. Group messages are shared
 * documents, so read state cannot live on the message the way the direct
 * message `isRead` flag does.
 */
@Schema({ timestamps: true, collection: 'ChatReadCursors' })
export class ChatReadCursor {
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: Users.name, required: true })
  user: Types.ObjectId;

  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: Group.name, required: true })
  groupId: Types.ObjectId;

  @Prop({ type: Date, required: true })
  lastReadAt: Date;
}

export const ChatReadCursorSchema =
  SchemaFactory.createForClass(ChatReadCursor);

ChatReadCursorSchema.index({ user: 1, groupId: 1 }, { unique: true });
