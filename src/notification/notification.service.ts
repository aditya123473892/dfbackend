import { Subject } from 'rxjs';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import {
  Notification,
  NotificationDocument,
} from 'src/common/schemas/notification.schema';
import { ENotificationType } from '../common/enums/notifications.enum';
import { BlockService } from '../user-blocks/block.service';

@Injectable()
export class NotificationService {
  readonly changes$ = new Subject<{ receiver: string; relationships?: boolean }>();
  socialChanged(a: string, b: string) {
    for (const receiver of new Set([a,b])) this.changes$.next({ receiver, relationships: true });
  }
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
        .select('_id type message createdAt isRead sender metadata.eventId metadata.navigation')
        .populate('sender', 'displayname avatar').lean(),
      this.notificationModel.countDocuments({ receiver, isRead: { $ne: true } }),
    ]);
    return {
      notifications: rows.slice(0, 20).map((row: any) => ({
        _id: row._id, type: row.type, message: row.message, createdAt: row.createdAt,
        read: row.isRead === true, sender: row.sender || null,
        ...(row.metadata?.navigation ? { navigation: row.metadata.navigation } : {}),
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
    this.changes$.next({ receiver });
  }

  async sendNotification(
    receiver: string,
    sender: string | null,
    type: ENotificationType,
    message: string,
    metadata?: any,
    dedupeKey?: string,
    session?: ClientSession,
  ) {
    if (sender && (await this.blocks.isBlockedEitherWay(sender, receiver)))
      return null;
    const data = {
      receiver,
      sender,
      type,
      message,
      metadata, pushQueued: false, ...(dedupeKey ? { dedupeKey } : {}),
    };
    let notification;
    try {
      notification = dedupeKey ? await this.notificationModel.findOneAndUpdate({ dedupeKey },
        { $setOnInsert: data }, { upsert: true, new: true, ...(session ? { session } : {}) })
        : session ? (await this.notificationModel.create([data], { session }))[0]
        : await this.notificationModel.create(data);
    } catch (error) {
      // A duplicate-key error aborts a transaction. The caller must retry the whole unit of work.
      if (session || !dedupeKey || error?.code !== 11000) throw error;
      notification = await this.notificationModel.findOne({ dedupeKey });
    }

    if (!notification) {
      throw new Error('Failed to send notification');
    }

    // Transactional callers emit only after the relationship and notification both commit.
    if (!session) this.changes$.next({ receiver });
    return notification;
  }
}
