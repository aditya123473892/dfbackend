import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { z } from 'zod';
import { REPORT_CATEGORIES } from '../../reports/report-input';

const objectId = z.string().regex(/^[a-f\d]{24}$/i);
export const mediaListInput = z.object({
  filter: z.enum(['all', 'flagged', 'premium', 'video']).default('all'),
  before: objectId.optional(),
}).strict();
export const visibilityInput = z.object({ contentVisibility: z.enum(['normal', 'premium']) }).strict();
export const flagInput = z.discriminatedUnion('flagged', [
  z.object({
    flagged: z.literal(true),
    reason: z.enum(REPORT_CATEGORIES),
    note: z.string().trim().max(300).optional(),
    hide: z.boolean().default(false),
  }).strict(),
  z.object({ flagged: z.literal(false) }).strict(),
]);
export function parseAdmin<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value ?? {});
  if (!result.success) throw new BadRequestException('Invalid admin media request');
  return result.data;
}
const PAGE = 30;

/**
 * Admin review of post media. Responses are raw post rows; the guarded admin
 * controller's PhotoResponseInterceptor maps and signs them (admin delivery).
 */
@Injectable()
export class AdminMediaService {
  constructor(@InjectConnection() private readonly db: Connection) {}
  private get posts() {
    return this.db.db.collection<any>('Posts');
  }

  async list(input: z.infer<typeof mediaListInput>) {
    const filter: any = {
      deletedAt: null,
      $or: [{ 'media.0': { $exists: true } }, { 'videos.0': { $exists: true } }],
      ...(input.before ? { _id: { $lt: new Types.ObjectId(input.before) } } : {}),
    };
    if (input.filter === 'flagged') filter.flag = { $exists: true };
    if (input.filter === 'premium') filter.contentVisibility = 'premium';
    if (input.filter === 'video') {
      delete filter.$or;
      filter['videos.0'] = { $exists: true };
    }
    const rows = await this.posts.find(filter).sort({ _id: -1 }).limit(PAGE + 1).toArray();
    const page = rows.slice(0, PAGE);
    const owners = [...new Set(page.map((row) => String(row.user)))].filter((id) => Types.ObjectId.isValid(id));
    const users = await this.db.db.collection('Users').find(
      { _id: { $in: owners.map((id) => new Types.ObjectId(id)) } },
      { projection: { displayname: 1, firstName: 1, lastName: 1, avatar: 1 } },
    ).toArray();
    const byId = new Map(users.map((user) => [String(user._id), user]));
    return {
      posts: page.map((row) => ({ ...row, user: byId.get(String(row.user)) || row.user })),
      nextCursor: rows.length > PAGE ? String(page[page.length - 1]._id) : null,
    };
  }

  async setVisibility(actorId: string, id: string, contentVisibility: 'normal' | 'premium') {
    const post = await this.find(id);
    if ((post.contentVisibility || 'normal') !== contentVisibility) {
      await this.posts.updateOne({ _id: post._id }, { $set: { contentVisibility, updatedAt: new Date() } });
      await this.audit(actorId, `content_visibility:${contentVisibility}`, id);
    }
    return { id, contentVisibility };
  }

  async setFlag(actorId: string, id: string, input: z.infer<typeof flagInput>) {
    const post = await this.find(id);
    // Restore the status that existed before the first hiding flag.
    const original = post.flag?.hidden ? post.flag.previousStatus || 'approved' : post.status;
    const update: any = input.flagged
      ? { $set: {
          flag: { reason: input.reason, note: input.note || '', hidden: input.hide, by: actorId, at: new Date(), previousStatus: original },
          status: input.hide ? 'archived' : original, updatedAt: new Date() } }
      : { $set: { status: original, updatedAt: new Date() }, $unset: { flag: '' } };
    const changed = await this.posts.updateOne({ _id: post._id, status: post.status }, update);
    if (!changed.matchedCount) throw new ConflictException('Post changed; refresh before trying again');
    await this.audit(actorId, input.flagged ? `flag:${input.reason}${input.hide ? ':hidden' : ''}` : 'unflag', id);
    return { id, flagged: input.flagged, hidden: input.flagged ? input.hide : false, status: update.$set.status };
  }

  private async find(id: string) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Post not found');
    const post = await this.posts.findOne({ _id: new Types.ObjectId(id), deletedAt: null });
    if (!post) throw new NotFoundException('Post not found');
    return post;
  }
  private async audit(actorId: string, action: string, postId: string) {
    await this.db.db.collection('AdminAuditLog').insertOne({ actorId, action, postId, at: new Date() });
  }
}
