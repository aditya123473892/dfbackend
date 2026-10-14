import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { Document } from 'mongoose';
import { UsersDocument } from './users.schema';
import { PostsDocument } from './posts.schema';

export type CommentDocument = Comment & Document;

@Schema({ timestamps: true, collection: 'Comments' })
export class Comment {
  @Prop({ required: true })
  content: string;

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

export const CommentSchema = SchemaFactory.createForClass(Comment);
