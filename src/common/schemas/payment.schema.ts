import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PaymentDocument = Payment & Document;

@Schema({ timestamps: true, collection: 'Payments' })
export class Payment {
  @Prop({ required: true })
  userId: string;

  @Prop({ required: true })
  amount: number;

  @Prop({ required: true })
  currency: string;

  @Prop({ required: true })
  paymentIntentId: string;

  @Prop({ required: true })
  status: string;

  @Prop({ required: true })
  paymentMethod: string;

  @Prop({ required: false })
  receiptUrl: string;
}

export const PaymentSchema = SchemaFactory.createForClass(Payment);
