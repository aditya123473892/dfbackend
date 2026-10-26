import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { z } from 'zod';

/** Oldest messages are dropped past this so one session document stays small. */
export const MAX_STORED_MESSAGES = 200;
const PAGE = 30;
/** A session with a message this recent is shown to admins as "live". */
export const LIVE_WINDOW_MS = 10 * 60_000;

export type SessionMode = 'ai' | 'staff';
export type StoredMessage = {
  id: string;
  /** 'event' rows are notices (staff joined/left) and are never sent to the model. */
  role: 'user' | 'assistant' | 'event';
  by: 'user' | 'ai' | 'staff' | 'system';
  staffId?: Types.ObjectId;
  content: string;
  at: Date;
};
export type StoredSession = {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  open: boolean;
  mode: SessionMode;
  staffId?: Types.ObjectId;
  takenOverAt?: Date;
  messages: StoredMessage[];
  createdAt: Date;
  updatedAt: Date;
  closedAt?: Date;
};

const objectId = z.string().regex(/^[a-f\d]{24}$/i);
const clientId = z.string().trim().min(8).max(64).regex(/^[\w-]+$/);
export const staffMessageInput = z.object({ id: clientId, content: z.string().trim().min(1).max(2000) }).strict();
export const sessionListInput = z.object({
  filter: z.enum(['open', 'live', 'staff']).default('open'),
  before: z.string().datetime().optional(),
}).strict();
export function parseSessions<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value ?? {});
  if (!result.success) throw new BadRequestException('Invalid God chat request');
  return result.data;
}
const toId = (value: string) => {
  if (!objectId.safeParse(value).success) throw new NotFoundException('Session not found');
  return new Types.ObjectId(value);
};

const USER_FIELDS = { username: 1, displayname: 1, firstName: 1, lastName: 1, avatar: 1 };

/** Persisted "Chat with God" conversations, readable and takeable by admins. */
@Injectable()
export class GodChatSessionsService implements OnModuleInit {
  private readonly logger = new Logger(GodChatSessionsService.name);
  constructor(@InjectConnection() private readonly db: Connection) {}

  private get sessions() {
    return this.db.db.collection<StoredSession>('GodChatSessions');
  }

  async onModuleInit() {
    try {
      await this.sessions.createIndex(
        { userId: 1 },
        { unique: true, partialFilterExpression: { open: true }, name: 'one_open_session_per_user' },
      );
      await this.sessions.createIndex({ open: 1, updatedAt: -1 }, { name: 'open_by_activity' });
    } catch (error) {
      this.logger.warn(`GodChatSessions indexes not created: ${(error as Error).message}`);
    }
  }

  // ---- member side -------------------------------------------------------

  findOpen(userId: string) {
    return this.sessions.findOne({ userId: new Types.ObjectId(userId), open: true });
  }

  /** Appends the member's message to their open session (creating it). Retried ids are not duplicated. */
  async appendUserMessage(userId: string, id: string, content: string): Promise<StoredSession> {
    const owner = new Types.ObjectId(userId);
    const now = new Date();
    const message: StoredMessage = { id, role: 'user', by: 'user', content, at: now };
    for (let attempt = 0; ; attempt++) {
      try {
        const session = await this.sessions.findOneAndUpdate(
          { userId: owner, open: true, 'messages.id': { $ne: id } },
          {
            $push: { messages: { $each: [message], $slice: -MAX_STORED_MESSAGES } },
            $set: { updatedAt: now },
            $setOnInsert: { mode: 'ai' as SessionMode, createdAt: now },
          },
          { upsert: true, returnDocument: 'after' },
        );
        return session!;
      } catch (error) {
        // Duplicate key: either a concurrent first message created the session, or this id
        // was already stored (the filter excluded the existing session and upsert collided).
        if ((error as { code?: number }).code !== 11000 || attempt > 0) throw error;
        const existing = await this.findOpen(userId);
        if (existing?.messages.some((row) => row.id === id)) return existing;
      }
    }
  }

  /** Stores the AI reply unless an admin took the session over while the model was thinking. */
  async appendAiReply(sessionId: Types.ObjectId, content: string) {
    const now = new Date();
    await this.sessions.updateOne(
      { _id: sessionId, open: true, mode: 'ai' },
      {
        $push: {
          messages: {
            $each: [{ id: new Types.ObjectId().toHexString(), role: 'assistant', by: 'ai', content, at: now }],
            $slice: -MAX_STORED_MESSAGES,
          },
        },
        $set: { updatedAt: now },
      },
    );
    return this.sessions.findOne({ _id: sessionId });
  }

  async closeOpen(userId: string) {
    const now = new Date();
    await this.sessions.updateOne(
      { userId: new Types.ObjectId(userId), open: true },
      { $set: { open: false, closedAt: now, updatedAt: now } },
    );
  }

  // ---- admin side --------------------------------------------------------

  async list(input: z.infer<typeof sessionListInput>) {
    const filter: Record<string, unknown> = { open: true };
    if (input.filter === 'live') filter.updatedAt = { $gte: new Date(Date.now() - LIVE_WINDOW_MS) };
    if (input.filter === 'staff') filter.mode = 'staff';
    if (input.before)
      filter.updatedAt = { ...((filter.updatedAt as object) ?? {}), $lt: new Date(input.before) };
    const rows = await this.sessions
      .aggregate<any>([
        { $match: filter },
        { $sort: { updatedAt: -1 } },
        { $limit: PAGE },
        { $lookup: { from: 'Users', localField: 'userId', foreignField: '_id', as: 'user', pipeline: [{ $project: USER_FIELDS }] } },
        { $lookup: { from: 'Users', localField: 'staffId', foreignField: '_id', as: 'staff', pipeline: [{ $project: USER_FIELDS }] } },
        {
          $project: {
            mode: 1, updatedAt: 1, createdAt: 1, takenOverAt: 1,
            user: { $first: '$user' },
            staff: { $first: '$staff' },
            messageCount: { $size: '$messages' },
            lastMessage: { $last: { $filter: { input: '$messages', cond: { $ne: ['$$this.role', 'event'] } } } },
          },
        },
      ])
      .toArray();
    const sessions = rows.map((row) => ({ ...row, live: Date.now() - new Date(row.updatedAt).getTime() < LIVE_WINDOW_MS }));
    return { sessions, next: rows.length === PAGE ? rows[rows.length - 1]!.updatedAt : null };
  }

  async detail(id: string) {
    const [row] = await this.sessions
      .aggregate<any>([
        { $match: { _id: toId(id) } },
        { $lookup: { from: 'Users', localField: 'userId', foreignField: '_id', as: 'user', pipeline: [{ $project: USER_FIELDS }] } },
        { $lookup: { from: 'Users', localField: 'staffId', foreignField: '_id', as: 'staff', pipeline: [{ $project: USER_FIELDS }] } },
        { $set: { user: { $first: '$user' }, staff: { $first: '$staff' } } },
      ])
      .toArray();
    if (!row) throw new NotFoundException('Session not found');
    return { ...row, live: Date.now() - new Date(row.updatedAt).getTime() < LIVE_WINDOW_MS };
  }

  /** Any admin may take over at any time, including from another admin. */
  async takeOver(actorId: string, id: string) {
    const staffId = new Types.ObjectId(actorId);
    const session = await this.sessions.findOne({ _id: toId(id), open: true });
    if (!session) throw new NotFoundException('This session has ended');
    if (session.mode === 'staff' && session.staffId?.equals(staffId)) return this.detail(id);
    const now = new Date();
    await this.sessions.updateOne(
      { _id: session._id, open: true },
      {
        $set: { mode: 'staff', staffId, takenOverAt: now, updatedAt: now },
        $push: { messages: { $each: [this.event('A member of the DARKFANTASY team has joined the chat.', now)], $slice: -MAX_STORED_MESSAGES } },
      },
    );
    this.logger.log(`Admin ${actorId} took over God chat session ${id}`);
    return this.detail(id);
  }

  async release(actorId: string, id: string) {
    const now = new Date();
    const result = await this.sessions.updateOne(
      { _id: toId(id), open: true, mode: 'staff' },
      {
        $set: { mode: 'ai', updatedAt: now },
        $unset: { staffId: '', takenOverAt: '' },
        $push: { messages: { $each: [this.event('The team member has left. God (AI) is answering again.', now)], $slice: -MAX_STORED_MESSAGES } },
      },
    );
    if (result.matchedCount) this.logger.log(`Admin ${actorId} released God chat session ${id}`);
    return this.detail(id);
  }

  async staffReply(actorId: string, id: string, input: z.infer<typeof staffMessageInput>) {
    const staffId = new Types.ObjectId(actorId);
    const now = new Date();
    const result = await this.sessions.updateOne(
      { _id: toId(id), open: true, mode: 'staff', staffId, 'messages.id': { $ne: input.id } },
      {
        $push: {
          messages: {
            $each: [{ id: input.id, role: 'assistant', by: 'staff', staffId, content: input.content, at: now }],
            $slice: -MAX_STORED_MESSAGES,
          },
        },
        $set: { updatedAt: now },
      },
    );
    if (!result.matchedCount) {
      const session = await this.sessions.findOne({ _id: toId(id) });
      if (!session?.open) throw new NotFoundException('This session has ended');
      if (!session.messages.some((row) => row.id === input.id))
        throw new ConflictException('Take over this session before replying');
    }
    return this.detail(id);
  }

  private event(content: string, at: Date): StoredMessage {
    return { id: new Types.ObjectId().toHexString(), role: 'event', by: 'system', content, at };
  }
}
