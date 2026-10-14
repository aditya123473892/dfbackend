import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { Users } from './users.schema';

export type GroupDocument = Group & Document;

@Schema({ timestamps: true, collection: 'Groups' })
export class Group {
  @Prop({ required: true })
  name: string;

  @Prop({ required: false })
  groupIcon: string;

  @Prop({ required: false })
  description: string;

  @Prop({ type: Types.ObjectId, ref: Users.name, required: true })
  admin: Types.ObjectId;

  @Prop({ type: [{ type: Types.ObjectId, ref: Users.name }], default: [] })
  members: Types.ObjectId[];
}

export const GroupSchema = SchemaFactory.createForClass(Group);
