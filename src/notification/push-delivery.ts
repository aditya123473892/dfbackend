import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Interval } from '@nestjs/schedule';
import { Connection, Types } from 'mongoose';
import { createHash } from 'crypto';
import { BlockService } from '../user-blocks/block.service';

export const validPushToken = (value: unknown): value is string =>
  typeof value === 'string' && /^(Expo|Exponent)PushToken\[[A-Za-z0-9_-]{10,200}\]$/.test(value);

/** Durable per-device outbox, leased across API processes. Never puts message content into pushes. */
@Injectable()
export class PushDelivery implements OnModuleInit {
  private running = false;
  constructor(@InjectConnection() private readonly db: Connection, private readonly blocks: BlockService) {}
  private get tokens() { return this.db.db.collection<any>('PushTokens'); }
  private get jobs() { return this.db.db.collection<any>('PushDeliveries'); }
  async onModuleInit() {
    await this.jobs.createIndex({ state: 1, nextAttempt: 1 });
    await this.tokens.createIndex({ owner: 1 });
  }
  async register(owner: string, token: string, remove = false) {
    if (!validPushToken(token)) throw new Error('Invalid push token');
    const _id = createHash('sha256').update(token).digest('hex');
    if (remove) await this.tokens.deleteOne({ _id, owner });
    else await this.tokens.updateOne({ _id }, { $set: { owner, token, updatedAt: new Date() } }, { upsert: true });
  }
  private async expo(endpoint: string, body: any) {
    const response = await fetch('https://exp.host/--/api/v2/push/' + endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json',
        ...(process.env.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error('Push service unavailable');
    const result = await response.json() as any;
    if (result.errors) throw new Error('Push service rejected request');
    return result.data;
  }
  @Interval(5000)
  async flush() {
    if (this.running) return;
    this.running = true;
    try {
      const notifications = this.db.db.collection<any>('Notifications');
      const rows = await notifications.find({ pushQueued: false }).sort({ _id: 1 }).limit(50).toArray();
      for (const row of rows) {
        for (const device of await this.tokens.find({ owner: String(row.receiver) }).limit(20).toArray()) {
          await this.jobs.updateOne({ _id: `${row._id}:${device._id}` }, { $setOnInsert: {
            owner: String(row.receiver), sender: row.sender ? String(row.sender) : null,
            device: device._id, token: device.token, notificationId: String(row._id),
            data: { notificationId: String(row._id), type: row.type, ...row.metadata?.navigation, recipientId: String(row.receiver) },
            state: 'pending', attempts: 0, nextAttempt: new Date(), createdAt: new Date(),
          } }, { upsert: true });
        }
        await notifications.updateOne({ _id: row._id }, { $set: { pushQueued: true } });
      }
      for (let n = 0; n < 30; n++) {
        const job = await this.jobs.findOneAndUpdate({ state: { $in: ['pending', 'receipt'] },
          nextAttempt: { $lte: new Date() } }, { $set: { nextAttempt: new Date(Date.now()+60000) } }, { returnDocument: 'before' });
        if (!job) break;
        try {
          // Logout, account switching and blocking revoke queued deliveries too.
          const device = await this.tokens.findOne({ _id: job.device, owner: job.owner, token: job.token });
          const owner = await this.db.db.collection('Users').findOne({ _id: new Types.ObjectId(job.owner),
            isBlocked: { $ne: true }, deletionRequestedAt: null, status: { $ne: 'blocked' },
            moderationSuspendedUntil: { $not: { $gt: new Date() } } });
          if (!device || !owner || (job.sender && await this.blocks.isBlockedEitherWay(job.sender, job.owner))) {
            await this.jobs.updateOne({ _id: job._id }, { $set: { state: 'cancelled' } }); continue;
          }
          const badge = await notifications.countDocuments({ receiver: new Types.ObjectId(job.owner), isRead: { $ne: true } });
          const result = job.state === 'receipt'
            ? (await this.expo('getReceipts', { ids: [job.ticket] }))?.[job.ticket]
            : (await this.expo('send', [{ to: job.token, title: 'DARKFANTASY', body: 'You have a new notification.',
                data: job.data, sound: 'default', channelId: 'social', tag: job.notificationId, collapseId: job.notificationId, badge }]))?.[0];
          if (!result) throw new Error('Push receipt pending');
          if (result.status === 'error') {
            if (result.details?.error === 'DeviceNotRegistered') {
              await this.tokens.deleteOne({ _id: job.device, owner: job.owner, token: job.token });
              await this.jobs.updateOne({ _id: job._id }, { $set: { state: 'invalid' } }); continue;
            }
            throw new Error('Push delivery failed');
          }
          if (result.status !== 'ok') throw new Error('Push delivery failed');
          await this.jobs.updateOne({ _id: job._id }, { $set: job.state === 'receipt'
            ? { state: 'delivered' } : { state: 'receipt', ticket: result.id, nextAttempt: new Date(Date.now()+900000) } });
        } catch {
          await this.jobs.updateOne({ _id: job._id }, { $inc: { attempts: 1 }, $set: {
            state: job.attempts >= 7 ? 'failed' : job.state,
            nextAttempt: new Date(Date.now()+Math.min(3600000, 30000 * 2 ** job.attempts)),
          } });
        }
      }
    } catch { /* Persistence remains intact; the next worker tick retries. */ }
    finally { this.running = false; }
  }
}
