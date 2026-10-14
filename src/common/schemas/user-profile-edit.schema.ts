import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import mongoose from "mongoose";
import { Users } from "./users.schema";

@Schema({ timestamps: true, collection: 'UserEdits' })
export class UserEditHistory {
  @Prop({
    required: true,
    ref: 'Users',
    type: mongoose.Schema.Types.ObjectId,
  })
  user: Users;

  @Prop({ required: true })
  remark: string;

  @Prop({ default: false })
  isAdminRequest: boolean;

}

export const UserEditHistorySchema = SchemaFactory.createForClass(UserEditHistory);
