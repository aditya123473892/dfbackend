import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { otpError, type OtpErrorCode } from './otp-errors';

export const THROTTLE_COLLECTION = 'OtpThrottle';

export interface ThrottleStore {
  /** Atomically counts one hit in the current fixed window and returns the window total. */
  hit(key: string, windowSeconds: number, now: number): Promise<number>;
  /** Starts a cooldown; returns 0 when claimed, otherwise the seconds still remaining. */
  claim(key: string, seconds: number, now: number): Promise<number>;
}

const isDuplicate = (error: any) => error?.code === 11000;

/** Shared across API instances. Rows expire through the TTL index on expiresAt. */
export class MongoThrottleStore implements ThrottleStore {
  constructor(private readonly db: Connection) {}

  private get rows() {
    return this.db.db.collection<{ _id: string; count?: number; until?: Date; expiresAt: Date }>(
      THROTTLE_COLLECTION,
    );
  }

  async hit(key: string, windowSeconds: number, now: number): Promise<number> {
    const bucket = Math.floor(now / (windowSeconds * 1000));
    const _id = `${key}:${windowSeconds}:${bucket}`;
    const update = {
      $inc: { count: 1 },
      $setOnInsert: { expiresAt: new Date((bucket + 1) * windowSeconds * 1000) },
    };
    for (let attempt = 0; ; attempt++) {
      try {
        const row = await this.rows.findOneAndUpdate({ _id }, update, {
          upsert: true,
          returnDocument: 'after',
        });
        return row?.count ?? 1;
      } catch (error) {
        // Two concurrent upserts of a new window: the loser retries as an update.
        if (!isDuplicate(error) || attempt) throw error;
      }
    }
  }

  async claim(key: string, seconds: number, now: number): Promise<number> {
    const until = new Date(now + seconds * 1000);
    try {
      await this.rows.updateOne(
        { _id: key, until: { $lte: new Date(now) } },
        { $set: { until, expiresAt: until } },
        { upsert: true },
      );
      return 0;
    } catch (error) {
      if (!isDuplicate(error)) throw error;
      const row = await this.rows.findOne({ _id: key });
      return Math.max(1, Math.ceil(((row?.until?.getTime() ?? now) - now) / 1000));
    }
  }
}

/** Single-process store for tests. */
export class MemoryThrottleStore implements ThrottleStore {
  private readonly counts = new Map<string, number>();
  private readonly cooldowns = new Map<string, number>();

  async hit(key: string, windowSeconds: number, now: number): Promise<number> {
    const id = `${key}:${windowSeconds}:${Math.floor(now / (windowSeconds * 1000))}`;
    const count = (this.counts.get(id) ?? 0) + 1;
    this.counts.set(id, count);
    return count;
  }

  async claim(key: string, seconds: number, now: number): Promise<number> {
    const until = this.cooldowns.get(key) ?? 0;
    if (until > now) return Math.ceil((until - now) / 1000);
    this.cooldowns.set(key, now + seconds * 1000);
    return 0;
  }
}

export type OtpLimits = {
  resendCooldownSeconds: number;
  sendPerPhone10m: number;
  sendPerPhoneDay: number;
  sendPerIp10m: number;
  sendPerIpDay: number;
  verifyPerPhone10m: number;
  verifyPerIp10m: number;
  passwordPerIp10m: number;
};

const positive = (value: unknown, fallback: number) => {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
};

export function readOtpLimits(get: (key: string) => unknown): OtpLimits {
  return {
    resendCooldownSeconds: Math.min(300, positive(get('OTP_RESEND_COOLDOWN_SECONDS'), 30)),
    sendPerPhone10m: positive(get('OTP_SEND_PER_PHONE_10M'), 3),
    sendPerPhoneDay: positive(get('OTP_SEND_PER_PHONE_DAY'), 10),
    sendPerIp10m: positive(get('OTP_SEND_PER_IP_10M'), 10),
    sendPerIpDay: positive(get('OTP_SEND_PER_IP_DAY'), 50),
    verifyPerPhone10m: positive(get('OTP_VERIFY_PER_PHONE_10M'), 10),
    verifyPerIp10m: positive(get('OTP_VERIFY_PER_IP_10M'), 30),
    passwordPerIp10m: positive(get('OTP_BOOTSTRAP_PER_IP_10M'), 10),
  };
}

export type ThrottleRule = { key: string; limit: number; windowSeconds: number };
export const TEN_MINUTES = 600;
export const ONE_DAY = 86_400;

@Injectable()
export class OtpThrottle {
  readonly limits: OtpLimits;
  readonly testingBypass: boolean;
  store: ThrottleStore;
  now = () => Date.now();

  constructor(config: ConfigService, @InjectConnection() db: Connection) {
    this.testingBypass = config.get('NODE_ENV') === 'development' &&
      config.get('OTP_DEV_BYPASS_RATE_LIMITS') === 'true';
    this.limits = readOtpLimits((key) => config.get(key));
    if (this.testingBypass) this.limits.resendCooldownSeconds = 0;
    this.store = new MongoThrottleStore(db);
  }

  /** Counts every rule (rejected attempts included) and fails on the first exceeded limit. */
  async consume(rules: ThrottleRule[], code: OtpErrorCode = 'OTP_RATE_LIMITED'): Promise<void> {
    if (this.testingBypass) return;
    const now = this.now();
    for (const rule of rules)
      if ((await this.store.hit(rule.key, rule.windowSeconds, now)) > rule.limit) throw otpError(code);
  }

  async cooldown(key: string): Promise<void> {
    if (this.testingBypass) return;
    const remaining = await this.store.claim(key, this.limits.resendCooldownSeconds, this.now());
    if (remaining > 0)
      throw otpError('OTP_COOLDOWN', `Please wait ${remaining} seconds before requesting another code.`);
  }
}
