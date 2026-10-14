import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { UserSubscriptionService } from './user-subscription.service';
import { UserSubscriptionController } from './user-subscription.controller';
import { UserSubscription, UserSubscriptionSchema } from '../common/schemas/user-subscription.schema';
import { UsersModule } from 'src/users/users.module';
import { CouponSchema } from 'src/common/schemas/coupon.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: UserSubscription.name, schema: UserSubscriptionSchema },
      { name: 'Coupons', schema: CouponSchema },
    ]),
    UsersModule,
  ],
  providers: [UserSubscriptionService],
  controllers: [UserSubscriptionController],
  exports: [UserSubscriptionService],
})
export class UserSubscriptionsModule {}
