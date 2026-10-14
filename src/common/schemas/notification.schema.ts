import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { Document } from 'mongoose';
import { Types } from 'mongoose';
import { UsersDocument } from './users.schema';
import { ENotificationType } from '../enums/notifications.enum';


export type NotificationDocument = Notification & Document;

@Schema({ timestamps: true, collection: 'Notifications' })
export class Notification {
  @Prop({
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Users',
    required: true
  })
  receiver: UsersDocument | mongoose.Schema.Types.ObjectId;

  @Prop({
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Users',
    required: false
  })
  sender?: UsersDocument | mongoose.Schema.Types.ObjectId;

  @Prop({ type: String, enum: Object.values(ENotificationType), required: true })
  type: ENotificationType;

  @Prop({ type: String, required: true })
  message: string;

  @Prop({ type: Object, required: false })
  metadata?: any; // Additional data (e.g., post ID, comment ID)

}

export const NotificationSchema = SchemaFactory.createForClass(Notification);
