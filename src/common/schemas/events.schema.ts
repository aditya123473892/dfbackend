import { Schema, SchemaFactory, Prop } from '@nestjs/mongoose';
import mongoose, { Document } from 'mongoose';
import { UsersDocument } from './users.schema';
import { Media } from './media.schema';

export enum EventType {
  ONLINE = 'online',
  OFFLINE = 'offline',
}

export enum EventStatus {
  UPCOMING = "upcoming",
  ACTIVE = 'active',
  CANCELED = 'canceled',
  COMPLETED = 'completed',
}

export type EventsDocument = Events & Document;

@Schema({ timestamps: true, collection: 'Events' })
export class Events {
  @Prop({ type: String, required: true })
  name: string;

  @Prop({ type: String })
  theme: string;

  @Prop({ type: String, required: true })
  description: string;

  @Prop({ required: true })
  startAt: Date;

  @Prop({ required: true })
  endAt: Date;

  @Prop()
  tags: any[];

  @Prop({
    enum: EventType,
    required: true,
    default: EventType.OFFLINE,
  })
  type: EventType;

  @Prop({ type: Media, required: false })
  cover: Media;

  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'Users', required: true })
  creator: UsersDocument | mongoose.Schema.Types.ObjectId;

  @Prop({ type: String, required: false })
  location: string;

  @Prop({ type: Number, required: false })
  capacity: number;

  @Prop({ type: Date, required: false })
  registrationDeadline: Date;

  @Prop({
    enum: EventStatus,
    required: true,
    default: EventStatus.UPCOMING,
  })
  status: EventStatus;

  @Prop({ type: [Media], required: false })
  media: Media[];
}

export const EventsSchema = SchemaFactory.createForClass(Events);
