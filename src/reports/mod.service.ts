import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { randomUUID } from 'crypto';
import { S3BucketService } from '../s3-bucket/s3-bucket.service';
import { StaffAuditService } from './staff-audit.service';
import { preservationGate } from './preservation';
import { actionInput, assignInput, holdInput, parseMod, transitionInput } from './mod-input';
import { BlockService } from '../user-blocks/block.service';
import { protectLastRoot } from '../users/role-policy';
import { decodeReportCursor, encodeReportCursor } from './reports.service';

type Actor = { id: string; roles: string[] };
@Injectable()
export class ModService {
  constructor(@InjectConnection() private readonly db: Connection,
    private readonly storage: S3BucketService, private readonly audit: StaffAuditService,
    private readonly blocks: BlockService) {}
  private admin(actor: Actor) { return actor.roles.some((role) => ['admin', 'root'].includes(role)); }
  private scope(actor: Actor) {
    return { reporterId: { $ne: actor.id }, targetOwnerId: { $ne: actor.id }, ...(!this.admin(actor) ? { restricted: { $ne: true } } : {}) };
  }
  private async case(actor: Actor, id: string, session?: any) {
    const report = await this.db.db.collection<any>('Reports').findOne({ _id: id, ...this.scope(actor) }, { session });
    if (!report) throw new NotFoundException('Case not found');
    return report;
  }
  private safe(report: any) {
    const { _id, reporterId, eligible, ...safe } = report;
    return { ...safe, revision: report.revision || 0 };
  }
  async queue(actor: Actor, before?: string) {
    // Report IDs are random UUIDs: page by createdAt, ID as tiebreak.
    const cursor = decodeReportCursor(before);
    const rows = await this.db.db.collection<any>('Reports').find({ ...this.scope(actor), open: true,
      ...(cursor ? { $or: [{ createdAt: { $lt: cursor.createdAt } }, { createdAt: cursor.createdAt, _id: { $lt: cursor.id } }] } : {}) },
      { projection: { details: 0, evidenceSnapshotRefs: 0 } })
      .sort({ createdAt: -1, _id: -1 }).limit(51).toArray();
    return { cases: rows.slice(0, 50).map((row) => this.safe(row)), nextCursor: rows.length > 50 ? encodeReportCursor(rows[49]) : null };
  }
  async detail(actor: Actor, id: string) {
    const report = await this.case(actor, id);
    // Snapshots can hold private DM text: every read is audited, and refused if the audit cannot be written.
    await this.auditCase(actor, report, report.restricted ? 'restricted_case_view' : 'case_view');
    // No source or destination storage keys. Images require the separate audited route.
    const evidence = await this.db.db.collection<any>(report.restricted ? 'RestrictedReportEvidence' : 'ReportEvidence')
      .find({ reportId: id }, { projection: { snapshot: 1, context: 1, 'images.evidenceId': 1, 'images.state': 1 } }).toArray();
    return { ...this.safe(report), evidence: evidence.map(({ _id, ...row }) => ({ evidenceId: _id, ...row,
      snapshot: this.safeSnapshot(row.snapshot), context: (row.context || []).map((item) => this.safeSnapshot(item)) })) };
  }
  private safeSnapshot(snapshot: any) {
    if (!snapshot) return snapshot;
    const { profilePhotos, ...safe } = snapshot;
    // Stored note is escaped at intake; evidence is escaped on output, never HTML.
    return Object.fromEntries(Object.entries(safe).map(([key, value]) => [key,
      typeof value === 'string' ? value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;') : value]));
  }
  private async names(ids: string[]) {
    const users = await this.db.db.collection('Users').find({ _id: { $in: [...new Set(ids)].filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id)) } },
      { projection: { displayname: 1, firstName: 1, lastName: 1, isBlocked: 1, moderationSuspendedUntil: 1 } }).toArray();
    return new Map(users.map((user: any) => [String(user._id), {
      id: String(user._id),
      name: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.displayname || 'Member',
      handle: user.displayname || '',
      restricted: !!user.isBlocked || user.moderationSuspendedUntil > new Date(),
    }]));
  }
  /** Who blocked whom, newest first. Rows involving the reviewer are excluded (conflict of interest). */
  async listBlocks(actor: Actor, before?: string) {
    const cursor = /^(\d{1,15})_([\w:-]{1,100})$/.exec(before || '');
    const actorId = new Types.ObjectId(actor.id);
    const rows = await this.db.db.collection<any>('UserBlocks').find({
      blockerId: { $ne: actorId }, blockedId: { $ne: actorId },
      ...(cursor ? { $or: [{ createdAt: { $lt: new Date(Number(cursor[1])) } }, { createdAt: new Date(Number(cursor[1])), _id: { $lt: cursor[2] } }] } : {}),
    }).sort({ createdAt: -1, _id: -1 }).limit(51).toArray();
    await this.audit.append({ actorId: actor.id, role: this.role(actor), action: 'blocks_view', reportId: 'blocks', reason: 'case_review' });
    const page = rows.slice(0, 50);
    const users = await this.names(page.flatMap((row) => [String(row.blockerId), String(row.blockedId)]));
    const unknown = (id: string) => ({ id, name: 'Deleted account', handle: '', restricted: true });
    return {
      blocks: page.map((row) => ({ id: String(row._id), createdAt: row.createdAt,
        blocker: users.get(String(row.blockerId)) || unknown(String(row.blockerId)),
        blocked: users.get(String(row.blockedId)) || unknown(String(row.blockedId)) })),
      nextCursor: rows.length > 50 ? `${new Date(page[49].createdAt).getTime()}_${page[49]._id}` : null,
    };
  }
  /** Most-blocked members, with their open report counts, to surface repeat offenders. */
  async blockSummary(actor: Actor) {
    const top = await this.db.db.collection('UserBlocks').aggregate([
      { $match: { blockedId: { $ne: new Types.ObjectId(actor.id) } } },
      { $group: { _id: '$blockedId', blocks: { $sum: 1 }, lastBlockedAt: { $max: '$createdAt' } } },
      { $sort: { blocks: -1, lastBlockedAt: -1 } }, { $limit: 20 },
    ]).toArray();
    await this.audit.append({ actorId: actor.id, role: this.role(actor), action: 'blocks_summary_view', reportId: 'blocks', reason: 'case_review' });
    const users = await this.names(top.map((row) => String(row._id)));
    const reports = await this.db.db.collection('Reports').aggregate([
      { $match: { open: true, targetOwnerId: { $in: top.map((row) => String(row._id)) }, ...this.scope(actor) } },
      { $group: { _id: '$targetOwnerId', count: { $sum: 1 } } },
    ]).toArray();
    const open = new Map(reports.map((row) => [String(row._id), row.count]));
    return top.map((row) => ({ user: users.get(String(row._id)) || { id: String(row._id), name: 'Deleted account', handle: '', restricted: true },
      blocks: row.blocks, lastBlockedAt: row.lastBlockedAt, openReports: open.get(String(row._id)) || 0 }));
  }
  private role(actor: Actor) { return actor.roles.includes('root') ? 'root' : this.admin(actor) ? 'admin' : 'moderator'; }
  async reviewQueue(actor: Actor) {
    const conflicts = await this.db.db.collection('Reports').distinct('targetOwnerId', { reporterId: actor.id });
    const cases = await this.db.db.collection<any>('ReportReviewQueue').find({ targetOwnerId: { $nin: [actor.id, ...conflicts] },
      ...(!this.admin(actor) ? { restricted: { $ne: true } } : {}) }).sort({ updatedAt: -1 }).limit(50).toArray();
    return cases.map(({ _id, ...row }) => row);
  }
  private async auditCase(actor: Actor, report: any, action: string, contentId?: string, s3Key?: string) {
    await this.audit.append({ actorId: actor.id, role: actor.roles.includes('root') ? 'root' : this.admin(actor) ? 'admin' : 'moderator',
      action, reportId: report.reportId, targetUserId: report.targetOwnerId, contentId, s3Key, reason: 'case_review' });
  }
  async evidence(actor: Actor, id: string, imageId: string) {
    return preservationGate(this.db, async () => {
      const report = await this.case(actor, id);
      const job = await this.db.db.collection<any>('ReportEvidenceJobs').findOne({ reportId: id, imageId });
      if (!job || !(await this.db.db.collection<any>('ReportHolds').findOne({ reportId: id, active: true })))
        throw new NotFoundException('Evidence not found');
      if (report.restricted) {
        if (!this.admin(actor)) throw new NotFoundException('Case not found');
        await this.auditCase(actor, report, 'restricted_evidence_view', imageId, job.sourceKey);
        try { return { bytes: await this.storage.readVerified(job.sourceKey, 'image/jpeg') }; }
        catch { throw new ServiceUnavailableException('Evidence is unavailable'); }
      }
      if (job.state !== 'copied' || !job.destinationKey?.startsWith(`reports/${id}/`))
        throw new ConflictException('Evidence copy is pending');
      await this.auditCase(actor, report, 'evidence_view', imageId, job.destinationKey);
      try { return { url: await this.storage.signReportEvidence(job.destinationKey), expiresIn: 60 }; }
      catch { throw new ServiceUnavailableException('Evidence is unavailable'); }
    });
  }
  async mutate(actor: Actor, id: string, kind: 'assign' | 'transition' | 'action' | 'legal-hold', body: unknown) {
    const input: any = parseMod(({ assign: assignInput, transition: transitionInput, action: actionInput, 'legal-hold': holdInput } as any)[kind], body);
    return preservationGate(this.db, async () => {
      const original = await this.case(actor, id);
      if ((original.revision || 0) !== input.revision) throw new ConflictException('Case changed; refresh before acting');
      if (kind === 'legal-hold' && !this.admin(actor)) throw new ForbiddenException();
      if (kind === 'action' && ['ban', 'delete_account'].includes(input.action) && !this.admin(actor)) throw new ForbiddenException();
      if (original.status === 'escalated' && !this.admin(actor)) throw new ForbiddenException('Admin review required');
      const status = kind === 'transition' ? input.status : kind === 'action'
        ? ({ dismiss: 'dismissed', escalate: 'escalated' }[input.action] || 'actioned') : undefined;
      if (status) {
        const transitions = { open: ['in_review'], in_review: ['actioned', 'dismissed', 'escalated'], escalated: this.admin(actor) ? ['in_review', 'actioned', 'dismissed'] : [] };
        if (!transitions[original.status]?.includes(status)) throw new ConflictException('Invalid case transition');
      }
      if (kind === 'assign') {
        input.moderatorId = new Types.ObjectId(input.moderatorId).toHexString();
        if ([original.reporterId, original.targetOwnerId].includes(input.moderatorId)) throw new BadRequestException('Reviewer is unavailable');
        const reviewer = await this.db.db.collection('Users').findOne({ _id: new Types.ObjectId(input.moderatorId), isBlocked: { $ne: true }, deletionRequestedAt: { $exists: false } });
        if (!reviewer || reviewer.moderationSuspendedUntil > new Date() || !reviewer.roles?.some((role) => ['admin', 'root', ...(!original.restricted ? ['moderator'] : [])].includes(role)))
          throw new BadRequestException('Reviewer is unavailable');
      }
      if (input.action === 'suspend') {
        const until = new Date(input.suspendedUntil);
        if (!Number.isFinite(until.getTime()) || until <= new Date() || until.getTime() > Date.now() + 30 * 86400000)
          throw new BadRequestException('Suspension must end within thirty days');
      }
      // Log the attempted action first. No report text, note, token or URL in audit.
      await this.auditCase(actor, original, `${kind}_attempt:${input.action || input.status || 'update'}`);
      const session = await this.db.startSession();
      try {
        await session.withTransaction(async () => {
          const report = await this.case(actor, id, session);
          const updates: any = {};
          if (status) Object.assign(updates, { status, open: !['actioned', 'dismissed'].includes(status),
            resolvedAt: ['actioned', 'dismissed'].includes(status) ? new Date() : null,
            resolution: ['actioned', 'dismissed'].includes(status) ? input.action || status : null });
          if (kind === 'assign') updates.assignedModerator = input.moderatorId;
          if (kind === 'legal-hold') updates.legalHold = input.legalHold;
          const changed = await this.db.db.collection<any>('Reports').updateOne({ _id: id,
            ...(input.revision === 0 ? { $or: [{ revision: 0 }, { revision: { $exists: false } }] } : { revision: input.revision }) },
            { $set: updates, $inc: { revision: 1 } }, { session });
          if (!changed.modifiedCount) throw new ConflictException('Case changed; refresh before acting');
          await this.db.db.collection<any>('ReportTransitions').insertOne({ _id: randomUUID(), reportId: id, actorId: actor.id,
            kind, action: input.action, from: report.status, to: status || report.status, note: input.note, createdAt: new Date() }, { session });
          const target = new Types.ObjectId(report.targetOwnerId);
          if (kind === 'action' && ['suspend', 'ban', 'delete_account'].includes(input.action)) {
            await protectLastRoot(this.db, report.targetOwnerId, session);
            const targetUser = await this.db.db.collection('Users').findOne({ _id: target }, { session });
            if (targetUser?.roles?.some((role) => ['root', 'admin'].includes(role)) && !actor.roles.includes('root')) throw new ForbiddenException('Root review required');
            if (targetUser?.roles?.includes('root') && await this.db.db.collection('Users').countDocuments({ roles: 'root', isBlocked: { $ne: true }, deletionRequestedAt: { $exists: false } }, { session }) <= 1)
              throw new ForbiddenException('The last root must be retained');
            await this.db.db.collection('Users').updateOne({ _id: target }, { $set: input.action === 'suspend'
              ? { moderationSuspendedUntil: new Date(input.suspendedUntil) } : { isBlocked: true,
                ...(input.action === 'delete_account' ? { deletionRequestedAt: new Date() } : {}) } }, { session });
            if (input.action === 'delete_account') await this.db.db.collection<any>('AccountPurges').updateOne({ _id: report.targetOwnerId },
              { $setOnInsert: { requestedAt: new Date(), dueAt: new Date(Date.now() + 600000), attempts: 0 } }, { upsert: true, session });
          }
          if (kind === 'action' && input.action === 'soft_remove') {
            const evidence = await this.db.db.collection<any>(report.restricted ? 'RestrictedReportEvidence' : 'ReportEvidence').findOne({ reportId: id }, { session });
            const collection = { user: 'Users', post: 'Posts', comment: 'Comments', event: 'Events', group: 'Groups', chat_message: 'ChatMessages', chat_media: 'ChatMessages' }[report.targetType];
            const contentId = report.messageId || report.targetId;
            await this.db.db.collection<any>('RestrictedContent').updateOne({ _id: `${collection}:${contentId}` },
              { $setOnInsert: { collection, contentId, ownerId: report.targetOwnerId, reportId: id, createdAt: new Date(), reason: 'moderation_removed' } }, { upsert: true, session });
            await this.db.db.collection(collection).updateOne({ _id: new Types.ObjectId(contentId) }, { $set: { deletedAt: new Date() } }, { session });
            for (const image of evidence?.images || []) {
              await this.db.db.collection<any>('PhotoDeletionJobs').updateOne({ key: image.sourceKey },
                { $setOnInsert: { key: image.sourceKey, dueAt: new Date(), attempts: 0 } }, { upsert: true, session });
              await this.db.db.collection('PhotoUploads').updateMany({ key: image.sourceKey },
                { $set: { state: 'deleting', status: 'deleting' } }, { session });
            }
          }
          if (status && ['actioned', 'dismissed'].includes(status)) {
            await this.notice(report.reporterId, status === 'actioned' ? 'Action taken' : 'No violation found', session, id);
            if (status === 'actioned') await this.notice(report.targetOwnerId, 'Your content or account violated our content policy. Please review the policy.', session);
          }
        }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
      } catch (error) {
        if (error instanceof HttpException) throw error;
        throw new ServiceUnavailableException('Moderation action could not be saved');
      } finally { await session.endSession(); }
      if (kind === 'action' && ['suspend', 'ban', 'delete_account'].includes(input.action)) this.blocks.suspensionChanges$.next(original.targetOwnerId);
      if (kind === 'action' && input.action === 'soft_remove') this.blocks.restrictedChanges$.next();
      return this.safe(await this.case(actor, id));
    });
  }
  private async notice(receiver: string, message: string, session: any, reportId?: string) {
    if (!await this.db.db.collection('Users').findOne({ _id: new Types.ObjectId(receiver) }, { session })) return;
    await this.db.db.collection('Notifications').insertOne({ receiver: new Types.ObjectId(receiver), sender: null,
      type: 'moderation_notice', message, metadata: { systemNotice: true, ...(reportId ? { reportId } : {}) }, isRead: false, createdAt: new Date() }, { session });
  }
}
