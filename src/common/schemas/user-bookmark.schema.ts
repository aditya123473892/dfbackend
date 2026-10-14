import { Schema, SchemaFactory, Prop } from '@nestjs/mongoose';
import mongoose, { Document } from 'mongoose';
import { UsersDocument } from './users.schema';

export type UserBookMarkDocument = UserBookMark & Document;

@Schema({ timestamps: true, collection: 'UserBookMark' })
export class UserBookMark {
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
    bookMarkUser: UsersDocument | mongoose.Schema.Types.ObjectId;

    @Prop({
        required: true,
        default: false,
    })
    status: boolean;

}

export const UserBookMarkSchema = SchemaFactory.createForClass(UserBookMark);