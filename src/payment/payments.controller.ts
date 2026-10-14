import { Controller, Post, Get, Param, Body } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { Payment } from '../common/schemas/payment.schema';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post()
  async createPayment(@Body() paymentData: Partial<Payment>): Promise<Payment> {
    return this.paymentsService.createPayment(paymentData);
  }

  @Get('user/:userId')
  async getUserPayments(@Param('userId') userId: string): Promise<Payment[]> {
    return this.paymentsService.getUserPayments(userId);
  }

  @Get(':paymentId')
  async getPaymentById(@Param('paymentId') paymentId: string): Promise<Payment> {
    return this.paymentsService.getPaymentById(paymentId);
  }
}
