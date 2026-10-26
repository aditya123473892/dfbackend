import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { Subject } from 'rxjs';
import { blockContext, blockedIds, pairBlocked } from './block-context';
import { blockIndexes, warnMissingBlockIndexes } from './block-indexes';
import { verifyBlockDatabase } from './block-startup';
import { recordReportAccess } from '../reports/evidence-reader';

@Injectable()
export class BlockService implements OnModuleInit, OnModuleDestroy {
  private stream: any;
  private restrictedStream: any;
  private staffStream: any;
  readonly suspensionChanges$ = new Subject<string>();
  readonly restrictedChanges$ = new Subject<void>();
  readonly changes$ = new Subject<{ a: string; b: string }>();
  readonly groupRemoval$ = new Subject<{
    groupId: string;
    members: string[];
  }>();
  constructor(@InjectConnection() private readonly db: Connection) {}
  async onModuleInit() {
    await verifyBlockDatabase(this.db);
    const mode = process.env.USER_BLOCK_INDEXES || 'off';
    if (!['off', 'report', 'apply'].includes(mode))
      throw new Error('Invalid USER_BLOCK_INDEXES');
    if (mode !== 'off') await blockIndexes(this.db, mode === 'apply');
    else await warnMissingBlockIndexes(this.db);
    // Replicate invalidation across backend processes. Authorization still reads
    // MongoDB at every delivery/sign even while a change stream reconnects.
    this.stream = this.db.db
      .collection('UserBlocks')
      .watch([], { fullDocument: 'updateLookup' });
    this.stream.on('change', (change) => {
      const row = change.fullDocument;
      const pair = String(change.documentKey?._id || '').split(':');
      const a = row ? String(row.blockerId) : pair[0],
        b = row ? String(row.blockedId) : pair[1];
      if (Types.ObjectId.isValid(a) && Types.ObjectId.isValid(b))
        this.changes$.next({ a, b });
    });
    this.stream.on('error', () =>
      Logger.warn(
        'UserBlocks invalidation stream unavailable; pair authorization continues to read MongoDB',
        'BlockService',
      ),
    );
    this.restrictedStream = this.db.db.collection('RestrictedContent').watch();
    this.restrictedStream.on('change', () => this.restrictedChanges$.next());
    this.restrictedStream.on('error', () => Logger.warn('Restricted visibility stream unavailable; fresh query/signing checks remain enforced', 'BlockService'));
    this.staffStream = this.db.db.collection('Users').watch([], { fullDocument: 'updateLookup' });
    this.staffStream.on('change', (change) => {
      if (change.fullDocument?.moderationSuspendedUntil > new Date() || change.fullDocument?.isBlocked)
        this.suspensionChanges$.next(String(change.documentKey._id));
    });
    this.staffStream.on('error', () => Logger.warn('Account suspension stream unavailable; per-packet authorization remains enforced', 'BlockService'));
  }
  async onModuleDestroy() {
    await this.stream?.close();
    await this.restrictedStream?.close();
    await this.staffStream?.close();
  }
  private async quota(actor: string) {
    try {
      await this.db.db
        .collection<any>('UserBlockQuotas')
        .updateOne(
          { _id: actor },
          { $setOnInsert: { revision: 0 } },
          { upsert: true },
        );
    } catch (error) {
      if (error.code !== 11000) throw error;
    }
  }
  private id(id: string) {
    if (!/^[a-f\d]{24}$/i.test(id))
      throw new NotFoundException('User not found!');
    return new Types.ObjectId(id);
  }
  ids(viewerId: string, fresh = false) {
    return blockedIds(this.db, viewerId, fresh);
  }
  async isBlockedEitherWay(a: string, b: string) {
    return pairBlocked(this.db, a, b);
  }
  async assertVisible(a: string, b: string, message = 'User not found!') {
    if (await this.isBlockedEitherWay(a, b))
      throw new NotFoundException(message);
  }
  async groupMembers(groupId: string): Promise<string[]> {
    const group = await this.db.db
      .collection('Groups')
      .findOne({ _id: this.id(groupId) }, { projection: { members: 1 } });
    return (group?.members || []).map(String);
  }
  async block(actor: string, target: string) {
    const blockerId = this.id(actor),
      blockedId = this.id(target);
    if (blockerId.equals(blockedId))
      throw new BadRequestException('You cannot block yourself');
    if (!(await this.db.db.collection('Users').findOne({ _id: blockedId })))
      throw new NotFoundException('User not found!');
    await this.quota(actor);
    const session = await this.db.startSession();
    try {
      // Serialize mutations per blocker and enforce the cap across processes. Requires
      // MongoDB replica-set transactions; never silently fall back to a racy count.
      await session.withTransaction(async () => {
        const quotas = this.db.db.collection<any>('UserBlockQuotas');
        await quotas.updateOne(
          { _id: actor },
          { $inc: { revision: 1 } },
          { session },
        );
        const rows = this.db.db.collection<any>('UserBlocks');
        const pair = { blockerId, blockedId };
        // Profiles were mutually visible immediately before the first pair block.
        if (!await rows.findOne({ $or: [pair, { blockerId: blockedId, blockedId: blockerId }] }, { session })) {
          for (const [viewer, peer] of [[actor, target], [target, actor]]) {
            const visible = await this.db.db.collection('Users').findOne({ _id: this.id(peer), isBlocked: { $ne: true }, deletionRequestedAt: { $exists: false } }, { session });
            const restricted = await this.db.db.collection<any>('RestrictedContent').findOne({ _id: `Users:${peer}` }, { session });
            if (visible && !restricted) await recordReportAccess(this.db, viewer, 'Users', peer, session);
          }
        }
        if (!(await rows.findOne(pair, { session }))) {
          if ((await rows.countDocuments({ blockerId }, { session })) >= 1000)
            throw new ConflictException('You can block up to 1,000 users');
          await rows.insertOne(
            { _id: `${actor}:${target}`, ...pair, createdAt: new Date() },
            { session },
          );
        }
        const both = [
          { follower: blockerId, following: blockedId },
          { follower: blockedId, following: blockerId },
        ];
        await this.db.db
          .collection('follows')
          .updateMany(
            { status: 'pending', $or: both },
            { $set: { status: 'rejected' } },
            { session },
          );
        await this.db.db.collection('PostRequest').updateMany(
          {
            status: 'pending',
            $or: [
              { userId: blockerId, requestedUserId: blockedId },
              { userId: blockedId, requestedUserId: blockerId },
            ],
          },
          { $set: { status: 'rejected' } },
          { session },
        );
      });
    } finally {
      await session.endSession();
    }
    const context = blockContext.getStore();
    if (context) context.ids = undefined;
    this.changes$.next({ a: actor, b: target });
    return { blocked: true };
  }
  async unblock(actor: string, target: string) {
    const blockerId = this.id(actor),
      blockedId = this.id(target);
    await this.quota(actor);
    const session = await this.db.startSession();
    try {
      await session.withTransaction(async () => {
        await this.db.db
          .collection<any>('UserBlockQuotas')
          .updateOne({ _id: actor }, { $inc: { revision: 1 } }, { session });
        await this.db.db
          .collection('UserBlocks')
          .deleteMany({ blockerId, blockedId }, { session });
      });
    } finally {
      await session.endSession();
    }
    const context = blockContext.getStore();
    if (context) context.ids = undefined;
    this.changes$.next({ a: actor, b: target });
    return { blocked: false };
  }
  async list(actor: string, before?: string, limit = 20) {
    const filter: any = { blockerId: this.id(actor) };
    // Composite string _ids are deterministic, so pagination does not need timestamps.
    if (before) filter._id = { $lt: `${actor}:${before}` };
    const rows = await this.db.db
      .collection<any>('UserBlocks')
      .find(filter)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .toArray();
    const page = rows.slice(0, limit);
    const users = await this.db.db
      .collection('Users')
      .find(
        { _id: { $in: page.map((row) => row.blockedId) } },
        { projection: { displayname: 1, username: 1 } },
      )
      .toArray();
    return {
      blocks: page.map((row) => ({
        id: String(row.blockedId),
        name:
          users.find((user) => user._id.equals(row.blockedId))?.displayname ||
          'User',
        createdAt: row.createdAt,
      })),
      nextCursor:
        rows.length > limit ? String(page[page.length - 1].blockedId) : null,
    };
  }
}
