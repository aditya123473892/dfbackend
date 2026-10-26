import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Notification,
  NotificationDocument,
} from 'src/common/schemas/notification.schema';
import { ENotificationType } from '../common/enums/notifications.enum';
import { BlockService } from '../user-blocks/block.service';

@Injectable()
export class NotificationService {
  constructor(
    @InjectModel(Notification.name)
    private notificationModel: Model<NotificationDocument>,
    private readonly blocks: BlockService,
  ) {}

  async list(receiver: string, before?: string) {
    const filter = { receiver, ...(before ? { _id: { $lt: new Types.ObjectId(before) } } : {}) };
    const [rows, unreadCount] = await Promise.all([
      this.notificationModel.find(filter)
        .sort({ _id: -1 }).limit(21)
        .select('_id type message createdAt isRead sender metadata.eventId')
        .populate('sender', 'displayname avatar').lean(),
      this.notificationModel.countDocuments({ receiver, isRead: { $ne: true } }),
    ]);
    return {
      notifications: rows.slice(0, 20).map((row: any) => ({
        _id: row._id, type: row.type, message: row.message, createdAt: row.createdAt,
        read: row.isRead === true, sender: row.sender || null,
        ...(row.type === ENotificationType.EVENT_MESSAGE && Types.ObjectId.isValid(row.metadata?.eventId)
          ? { eventId: String(row.metadata.eventId) } : {}),
      })),
      nextCursor: rows.length > 20 ? String(rows[19]._id) : undefined,
      unreadCount,
    };
  }

  async markRead(receiver: string, ids?: string[]) {
    await this.notificationModel.updateMany(
      { receiver, ...(ids ? { _id: { $in: ids } } : {}), isRead: { $ne: true } },
      { $set: { isRead: true } },
    );
  }

  async sendNotification(
    receiver: string,
    sender: string | null,
    type: ENotificationType,
    message: string,
    metadata?: any,
  ) {
    if (sender && (await this.blocks.isBlockedEitherWay(sender, receiver)))
      return null;
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
