import { Schema, SchemaFactory, Prop } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { Subscription } from './subscription.schema';
import { Types } from 'mongoose';

export type CouponDocument = Coupon & Document;

@Schema({ timestamps: true, collection: 'Coupons' })
export class Coupon {
  @Prop({ required: true, unique: true })
  code: string;

  @Prop({ required: true, type: Types.ObjectId, ref: 'Subscription' })
  subscription: Types.ObjectId;

  @Prop({ required: true })
  discountType: 'percentage' | 'fixed';

  @Prop({ required: true })
  discountValue: number;

  @Prop({ default: true })
  isActive: boolean;

  @Prop({ required: true })
  expiryDate: Date;
}

export const CouponSchema = SchemaFactory.createForClass(Coupon);
