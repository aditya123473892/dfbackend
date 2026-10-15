import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { Users } from './users.schema';

export type GroupDocument = Group & Document;

@Schema({ timestamps: true, collection: 'Groups' })
export class Group {
  @Prop({ required: true })
  name: string;

  // Legacy: a signed URL stored at upload time (it expires). New uploads store
  // the private object key in groupIconKey and are signed when read.
  @Prop({ required: false })
  groupIcon: string;

  @Prop({ required: false })
  groupIconKey?: string;

  @Prop({ required: false })
  description: string;

  @Prop({ type: Types.ObjectId, ref: Users.name, required: true })
  admin: Types.ObjectId;

  @Prop({ type: [{ type: Types.ObjectId, ref: Users.name }], default: [] })
  members: Types.ObjectId[];

  // Creation idempotency key, unique per owner: a retried create request
  // returns the group stored by the first attempt.
  @Prop({ required: false })
  clientId?: string;
}

export const GroupSchema = SchemaFactory.createForClass(Group);

GroupSchema.index({ members: 1 });
GroupSchema.index(
  { admin: 1, clientId: 1 },
  { unique: true, partialFilterExpression: { clientId: { $type: 'string' } } },
);
