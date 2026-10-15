import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { Document } from 'mongoose';
import { UsersDocument } from './users.schema';
import { PostsDocument } from './posts.schema';

export type LikeDocument = Like & Document;

@Schema({ timestamps: true, collection: 'Likes' })
export class Like {
  @Prop({
    required: true,
    ref: 'Users',
    type: mongoose.Schema.Types.ObjectId,
  })
  user: UsersDocument | mongoose.Schema.Types.ObjectId;

  @Prop({
    required: true,
    ref: 'Posts',
    type: mongoose.Schema.Types.ObjectId,
  })
  post: PostsDocument | mongoose.Schema.Types.ObjectId;
}

export const LikeSchema = SchemaFactory.createForClass(Like);

// One like per user per post. Existing duplicates must be removed before this
// index can build: `npm run db:repair-post-interactions`.
LikeSchema.index({ post: 1, user: 1 }, { unique: true });
