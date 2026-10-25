import { Schema, SchemaFactory, Prop } from '@nestjs/mongoose';
import mongoose, { Document } from 'mongoose';
import { EPostStatus, EPostVisibility } from '../enums/posts.enum';
import { UsersDocument } from './users.schema';

export type PostRequestDocument = PostRequest & Document;

@Schema({ timestamps: true, collection: 'PostRequest' })
export class PostRequest {
    @Prop({
        required: true,
        ref: 'Users',
        type: mongoose.Schema.Types.ObjectId,
    })
    userId: UsersDocument | mongoose.Schema.Types.ObjectId;

    @Prop({
        required: true,
        ref: 'Users',
        type: mongoose.Schema.Types.ObjectId,
    })
    requestedUserId: UsersDocument | mongoose.Schema.Types.ObjectId;

    @Prop({ type: String,
        enum: EPostStatus,
        required: true,
        default: EPostStatus.PENDING,
    })
    status: EPostStatus;

    @Prop({
        type: Date,
        default: null,
    })
    startTime: Date;

    @Prop({
        type: Date,
        default: null,
    })
    endTime: Date;

}

export const PostRequestSchema = SchemaFactory.createForClass(PostRequest);