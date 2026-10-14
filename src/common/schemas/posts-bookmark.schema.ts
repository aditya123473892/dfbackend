import { Schema, SchemaFactory, Prop } from '@nestjs/mongoose';
import mongoose, { Document } from 'mongoose';
import { PostsDocument } from './posts.schema';
import { UsersDocument } from './users.schema';

export type PostBookMarkDocument = PostBookMark & Document;

@Schema({ timestamps: true, collection: 'PostBookMark' })
export class PostBookMark {
    @Prop({
        required: true,
        ref: 'Users',
        type: mongoose.Schema.Types.ObjectId,
    })
    userId: UsersDocument | mongoose.Schema.Types.ObjectId;

    @Prop({
        required: true,
        ref: 'Posts',
        type: mongoose.Schema.Types.ObjectId,
    })
    postId: PostsDocument | mongoose.Schema.Types.ObjectId;

    @Prop({
        required: true,
        default: false,
    })
    status: boolean;
}

export const PostBookMarkSchema = SchemaFactory.createForClass(PostBookMark);
