import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Notification, NotificationSchema } from '../common/schemas/notification.schema';
import { NotificationService } from './notification.service';
import { NotificationController } from './notification.controller';
import { PushDelivery } from './push-delivery';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Notification.name, schema: NotificationSchema }]),
  ],
  providers: [NotificationService, PushDelivery],
  controllers: [NotificationController],
  exports: [NotificationService, PushDelivery],
})
export class NotificationModule {}
