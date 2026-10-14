import { Schema, SchemaFactory, Prop } from '@nestjs/mongoose';
import mongoose, { Document, Types } from 'mongoose';
import { UsersDocument } from './users.schema';
import { SubscriptionDocument } from './subscription.schema';
import { CouponDocument } from './coupon.schema';

export type UserSubscriptionDocument = UserSubscription & Document;

@Schema({ timestamps: true, collection: 'UserSubscriptions' })
export class UserSubscription {
  @Prop({
    required: true,
    ref: 'Users',
    type: mongoose.Schema.Types.ObjectId,
  })
  user: UsersDocument | mongoose.Schema.Types.ObjectId;


  @Prop({ required: true, type: mongoose.Schema.Types.ObjectId, ref: 'Subscription' })
  subscription: SubscriptionDocument | mongoose.Schema.Types.ObjectId;

  @Prop({ required: true, type: mongoose.Schema.Types.ObjectId, ref: 'Coupons' })
  coupon: CouponDocument | mongoose.Schema.Types.ObjectId;

  // @Prop({ type: String, required: false })
  // email: string;

  // @Prop({ type: String, required: false })
  // country: string;

  @Prop({ type: String, required: false })
  fu: string;
}

export const UserSubscriptionSchema = SchemaFactory.createForClass(UserSubscription);
