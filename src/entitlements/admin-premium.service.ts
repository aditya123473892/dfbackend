import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { z } from 'zod';
import { isPremium } from '../posts/post.mapper';

/** Stored for "no end date" grants; far enough away to never expire in practice. */
export const LIFETIME_UNTIL = new Date('9999-12-31T23:59:59.000Z');
const PAGE = 30;
const objectId = z.string().regex(/^[a-f\d]{24}$/i);

export const memberListInput = z.object({
  filter: z.enum(['all', 'premium', 'normal']).default('all'),
  search: z.string().trim().max(100).optional(),
  before: objectId.optional(),
}).strict();

/**
 * Grant: months (1-120) extends any remaining premium time; lifetime never expires.
 * Revoke: premium false ends premium immediately.
 */
export const premiumChangeInput = z.union([
  z.object({ premium: z.literal(true), months: z.number().int().min(1).max(120) }).strict(),
  z.object({ premium: z.literal(true), lifetime: z.literal(true) }).strict(),
  z.object({ premium: z.literal(false) }).strict(),
]);
export type PremiumChange = z.infer<typeof premiumChangeInput>;

export function parseMemberInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value ?? {});
  if (!result.success) throw new BadRequestException('Invalid premium request');
  return result.data;
}

/** Adds calendar months in UTC, clamping to the last day of a shorter month. */
export function addMonths(from: Date, months: number) {
  const result = new Date(from);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const last = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, last));
  return result;
}

export function nextPremiumUntil(current: Date | string | null | undefined, change: PremiumChange, now = new Date()) {
  if (!change.premium) return null;
  if ('lifetime' in change) return LIFETIME_UNTIL;
  // Extend from the current end date when still active, so a grant never shortens premium.
  const active = current && new Date(current).getTime() > now.getTime();
  if (active && new Date(current).getTime() >= LIFETIME_UNTIL.getTime()) return LIFETIME_UNTIL;
  return addMonths(active ? new Date(current) : now, change.months);
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function toMember(user: any, now = Date.now()) {
  const premiumUntil = user.premiumUntil || null;
  return {
    _id: String(user._id),
    displayname: user.displayname,
    firstName: user.firstName || '',
    lastName: user.lastName || '',
    username: user.username,
    avatar: user.avatar,
    roles: user.roles || [],
    isBlocked: !!user.isBlocked,
    premium: isPremium(user, now),
    lifetime: !!premiumUntil && new Date(premiumUntil).getTime() >= LIFETIME_UNTIL.getTime(),
    premiumUntil,
  };
}

/** Admin-only switching of members between normal and premium. Every change is audited. */
@Injectable()
export class AdminPremiumService {
  constructor(@InjectConnection() private readonly db: Connection) {}
  private get users() {
    return this.db.db.collection<any>('Users');
  }

  async list(input: z.infer<typeof memberListInput>) {
    const now = new Date();
    const and: any[] = [{ deletionRequestedAt: { $exists: false } }];
    if (input.before) and.push({ _id: { $lt: new Types.ObjectId(input.before) } });
    if (input.filter === 'premium') and.push({ premiumUntil: { $gt: now } });
    if (input.filter === 'normal') and.push({ $or: [{ premiumUntil: null }, { premiumUntil: { $lte: now } }] });
    if (input.search) {
      const pattern = new RegExp(escapeRegex(input.search).replace(/\s+/g, '\\s+'), 'i');
      and.push({ $or: ['displayname', 'username', 'firstName', 'lastName'].map((field) => ({ [field]: pattern })) });
    }
    const rows = await this.users.find({ $and: and }, {
      projection: { displayname: 1, firstName: 1, lastName: 1, username: 1, avatar: 1, roles: 1, isBlocked: 1, premiumUntil: 1 },
    }).sort({ _id: -1 }).limit(PAGE + 1).toArray();
    const page = rows.slice(0, PAGE);
    return {
      users: page.map((user) => toMember(user, now.getTime())),
      nextCursor: rows.length > PAGE ? String(page[page.length - 1]._id) : null,
    };
  }

  async setPremium(actorId: string, userId: string, change: PremiumChange) {
    if (!Types.ObjectId.isValid(userId)) throw new NotFoundException('User not found');
    const _id = new Types.ObjectId(userId);
    const user = await this.users.findOne(
      { _id, deletionRequestedAt: { $exists: false } },
      { projection: { premiumUntil: 1 } },
    );
    if (!user) throw new NotFoundException('User not found');
    const previous = user.premiumUntil ?? null;
    const premiumUntil = nextPremiumUntil(previous, change);
    // Compare-and-set so two admins acting at once cannot silently overwrite each other.
    const result = await this.users.updateOne(
      { _id, premiumUntil: previous },
      { $set: { premiumUntil, updatedAt: new Date() } },
    );
    if (!result.matchedCount) throw new ConflictException('Membership changed; refresh before trying again');
    await this.db.db.collection('AdminAuditLog').insertOne({
      actorId,
      action: change.premium ? ('lifetime' in change ? 'premium:grant:lifetime' : `premium:grant:${change.months}m`) : 'premium:revoke',
      userId,
      previousPremiumUntil: previous,
      premiumUntil,
      at: new Date(),
    });
    const updated = await this.users.findOne({ _id }, {
      projection: { displayname: 1, firstName: 1, lastName: 1, username: 1, avatar: 1, roles: 1, isBlocked: 1, premiumUntil: 1 },
    });
    return toMember(updated);
  }
}
