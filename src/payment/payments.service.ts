import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Payment, PaymentDocument } from '../common/schemas/payment.schema';

@Injectable()
export class PaymentsService {
  constructor(
    @InjectModel(Payment.name) private paymentModel: Model<PaymentDocument>,
  ) {}

  async createPayment(paymentData: Partial<Payment>): Promise<Payment> {
    const payment = new this.paymentModel(paymentData);
    return payment.save();
  }

  async getUserPayments(userId: string): Promise<Payment[]> {
    return this.paymentModel.find({ userId }).sort({ createdAt: -1 }).exec();
  }

  async getPaymentById(paymentId: string): Promise<Payment> {
    return this.paymentModel.findById(paymentId).exec();
  }
}
