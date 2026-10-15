import { Schema, SchemaFactory, Prop } from '@nestjs/mongoose';
import mongoose, { Document } from 'mongoose';
import { EPostStatus, EPostVisibility } from '../enums/posts.enum';
import { UsersDocument } from './users.schema';
import { Media } from './media.schema';
import { Like } from './like.schema';
import { Comment } from './comment.schema';

export type PostsDocument = Posts & Document;

@Schema({ timestamps: true, collection: 'Posts' })
export class Posts {
  @Prop({ required: false })
  caption: string;

  @Prop({ type: [Media], required: false })
  media: Media[];

  @Prop({
    enum: EPostVisibility,
    required: true,
    default: EPostVisibility.PRIVATE,
  })
  visibility: EPostVisibility;

  @Prop({
    enum: EPostStatus,
    required: true,
    default: EPostStatus.PENDING,
  })
  status: EPostStatus;

  @Prop({ required: false })
  location: string;

  @Prop({ required: false })
  tags: string[];

  @Prop({
    required: true,
    ref: 'Users',
    type: mongoose.Schema.Types.ObjectId,
  })
  user: UsersDocument | mongoose.Schema.Types.ObjectId;

  @Prop({ type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Comment' }] })
  comments: Comment[];

  @Prop({ type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Like' }] })
  likes: Like[];

  // Compare-and-set version for rebuilding `likes` from the Likes collection.
  @Prop({ type: Number, default: 0 })
  likesVersion: number;
}

export const PostsSchema = SchemaFactory.createForClass(Posts);

PostsSchema.index({ visibility: 1, status: 1, createdAt: -1 });
PostsSchema.index({ user: 1, createdAt: -1 });
