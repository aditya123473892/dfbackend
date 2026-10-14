import { Injectable } from '@nestjs/common';
import Stripe from 'stripe';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class StripeService {
  private stripe: Stripe;

//   constructor(private configService: ConfigService) {
//     this.stripe = new Stripe(this.configService.get<string>('STRIPE_SECRET_KEY'), {
//       apiVersion: '2025-01-27.acacia',
//     });
//   }

  async createPaymentIntent(amount: number, currency: string) {
    return this.stripe.paymentIntents.create({
      amount,
      currency,
      payment_method_types: ['card'],
    });
  }
}
