import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Notification, NotificationDocument } from 'src/common/schemas/notification.schema';
import { ENotificationType } from '../common/enums/notifications.enum';

@Injectable()
export class NotificationService {
    constructor(
        @InjectModel(Notification.name) private notificationModel: Model<NotificationDocument>,
    ) { }

    async sendNotification(
        receiver: string,
        sender: string | null,
        type: ENotificationType,
        message: string,
        metadata?: any,
    ) {
        const notification = await this.notificationModel.create({
            receiver,
            sender,
            type,
            message,
            metadata,
        });

        if (!notification) {
            throw new Error('Failed to send notification');
        }

        return notification;
    }

}
