import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Subscription, SubscriptionSchema } from '../common/schemas/subscription.schema';
import { SubscriptionService } from './subscription.service';
import { SubscriptionController } from './subscription.controller';
import { UsersModule } from 'src/users/users.module';
import { MailService } from 'src/mail/mail.service';
import { FileHandlebarsAdapter } from 'src/common/adapters';

@Module({
    imports: [
      UsersModule,
      MongooseModule.forFeature([{ name: Subscription.name, schema: SubscriptionSchema }]),
    ],
    controllers: [SubscriptionController],
    providers: [SubscriptionService,MailService,FileHandlebarsAdapter],
  })
export class SubscriptionsModule {}
