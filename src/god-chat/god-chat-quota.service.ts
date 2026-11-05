import { HttpException, HttpStatus, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { isPremium } from '../posts/post.mapper';

export const DEFAULT_FREE_DAILY_MESSAGES = 10;
/** Staff test and support the chat; they are never limited. */
const UNLIMITED_ROLES = ['root', 'admin', 'manager', 'moderator'];
export const DAILY_LIMIT_ERROR = 'GOD_CHAT_DAILY_LIMIT';

export type GodChatQuota = {
  /** Premium members and staff: no daily limit. */
  unlimited: boolean;
  limit: number;
  used: number;
  remaining: number;
  /** Next UTC midnight, when the free count starts again. */
  resetsAt: string;
};

type UsageRow = { _id: string; userId: string; day: string; count: number; ids: string[]; expiresAt: Date };

export const utcDay = (now: Date) => now.toISOString().slice(0, 10);
export const nextUtcMidnight = (now: Date) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));

/**
 * Free members may send a fixed number of messages to the AI each UTC day. Each message id is
 * counted once, so retrying a failed send never uses up another message.
 */
@Injectable()
export class GodChatQuotaService implements OnModuleInit {
  private readonly logger = new Logger(GodChatQuotaService.name);
  constructor(
    @InjectConnection() private readonly db: Connection,
    private readonly config: ConfigService,
  ) {}

  private get usage() {
    return this.db.db.collection<UsageRow>('GodChatUsage');
  }

  async onModuleInit() {
    try {
      await this.usage.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'usage_ttl' });
    } catch (error) {
      this.logger.warn(`GodChatUsage index not created: ${(error as Error).message}`);
    }
  }

  get limit(): number {
    const value = Number(this.config.get('GOD_CHAT_FREE_DAILY_MESSAGES'));
    return Number.isInteger(value) && value >= 0 ? value : DEFAULT_FREE_DAILY_MESSAGES;
  }

  private async unlimited(userId: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(userId)) return false;
    const user = await this.db.db.collection<any>('Users').findOne(
      { _id: new Types.ObjectId(userId) },
      { projection: { roles: 1, premiumUntil: 1 } },
    );
    return Boolean(user?.roles?.some((role: string) => UNLIMITED_ROLES.includes(role)) || isPremium(user));
  }

  async status(userId: string, now = new Date()): Promise<GodChatQuota> {
    const limit = this.limit;
    const resetsAt = nextUtcMidnight(now).toISOString();
    if (await this.unlimited(userId)) return { unlimited: true, limit, used: 0, remaining: limit, resetsAt };
    const row = await this.usage.findOne({ _id: `${userId}:${utcDay(now)}` });
    const used = Math.min(row?.count ?? 0, limit);
    return { unlimited: false, limit, used, remaining: limit - used, resetsAt };
  }

  /** Counts one message, or throws 429 GOD_CHAT_DAILY_LIMIT when today's free messages are used up. */
  async consume(userId: string, messageId: string, now = new Date()): Promise<void> {
    if (await this.unlimited(userId)) return;
    const limit = this.limit;
    const day = utcDay(now);
    const _id = `${userId}:${day}`;
    if ((await this.usage.findOne({ _id }))?.ids?.includes(messageId)) return;
    try {
      const result = await this.usage.updateOne(
        { _id, count: { $lt: limit }, ids: { $ne: messageId } },
        {
          $inc: { count: 1 },
          $push: { ids: messageId },
          // Kept a day past its end so a slow clock never reopens yesterday's count.
          $setOnInsert: { userId, day, expiresAt: new Date(nextUtcMidnight(now).getTime() + 86_400_000) },
        },
        { upsert: true },
      );
      if (result.matchedCount || result.upsertedCount) return;
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
    }
    // No match: today's count is full, unless a concurrent retry just stored this same id.
    if ((await this.usage.findOne({ _id }))?.ids?.includes(messageId)) return;
    throw this.limitError(limit, now);
  }

  private limitError(limit: number, now: Date) {
    return new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        error: DAILY_LIMIT_ERROR,
        message: `You've used your ${limit} free messages for today. Go premium for unlimited chats, or come back tomorrow.`,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
