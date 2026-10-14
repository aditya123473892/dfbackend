import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { Document, Types } from 'mongoose';
import { Users, UsersDocument } from './users.schema';

export enum FollowStatus {
    PENDING = 'pending',
    ACCEPTED = 'accepted',
    REJECTED = 'rejected',
}

export type FollowDocument = Follow & Document;

@Schema({ timestamps: true })
export class Follow {
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'Users' })
  follower: UsersDocument | mongoose.Schema.Types.ObjectId;

  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'Users' })
  following: UsersDocument | mongoose.Schema.Types.ObjectId;

  @Prop({ type: String, enum: FollowStatus, default: FollowStatus.PENDING })
  status: FollowStatus;
}

export const FollowSchema = SchemaFactory.createForClass(Follow);
