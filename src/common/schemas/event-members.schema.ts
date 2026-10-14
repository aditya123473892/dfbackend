import { Schema, SchemaFactory, Prop } from '@nestjs/mongoose';
import mongoose, { Document } from 'mongoose';
import { UsersDocument } from './users.schema';
import { EventsDocument } from './events.schema';

export enum EventRequestStatus {
  PENDING = 'pending',
  ACCEPTED = 'accepted',
  REJECTED = 'rejected',
  CANCELED = 'canceled',
}

export type EventMembersDocument = EventMembers & Document;

@Schema({ timestamps: true, collection: 'EventMembers' })
export class EventMembers {
  @Prop({
    required: true,
    ref: 'Users',
    type: mongoose.Schema.Types.ObjectId,
  })
  user: UsersDocument | mongoose.Schema.Types.ObjectId;

  @Prop({
    required: true,
    ref: 'Events',
    type: mongoose.Schema.Types.ObjectId,
  })
  event: EventsDocument | mongoose.Schema.Types.ObjectId;

  @Prop({
    enum: EventRequestStatus,
    required: true,
    default: EventRequestStatus.PENDING,
  })
  requestStatus: EventRequestStatus;

  @Prop()
  remark: string;
}

export const EventMembersSchema = SchemaFactory.createForClass(EventMembers);
