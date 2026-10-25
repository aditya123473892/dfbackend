import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types } from 'mongoose';
/** Separate from Users.isBlocked. Writes use transactions in BlockService. */
@Schema({ collection: 'UserBlocks', autoIndex: false })
export class UserBlock {
  @Prop({ type: String }) _id: string;
  @Prop({ type: Types.ObjectId, required: true }) blockerId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, required: true }) blockedId: Types.ObjectId;
  @Prop({ type: Date, required: true }) createdAt: Date;
}
export const UserBlockSchema = SchemaFactory.createForClass(UserBlock);
UserBlockSchema.index({ blockerId: 1, blockedId: 1 }, { unique: true });
UserBlockSchema.index({ blockedId: 1 });
