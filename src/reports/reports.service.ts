import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { randomUUID } from 'crypto';
import { Cron, CronExpression } from '@nestjs/schedule';
import { S3BucketService } from '../s3-bucket/s3-bucket.service';
import { readReportSource } from './evidence-reader';
import { reportInput, sanitizeReportText } from './report-input';
import { preservationGate } from './preservation';
import { reportIndexes } from './report-indexes';
export function encodeReportCursor(row: { createdAt: Date; reportId: string }) {
  return `${new Date(row.createdAt).getTime()}_${row.reportId}`;
}
export function decodeReportCursor(value?: string) {
  const match = /^(\d{1,15})_([\w-]{1,100})$/.exec(value || '');
  return match
    ? { createdAt: new Date(Number(match[1])), id: match[2] }
    : undefined;
}
const REPORT_TRANSACTION = {
  readConcern: { level: 'snapshot' as const },
  writeConcern: { w: 'majority' as const },
  readPreference: 'primary' as const,
};

@Injectable()
export class ReportsService implements OnModuleInit {
  private readonly logger = new Logger(ReportsService.name);
  @Cron(CronExpression.EVERY_MINUTE)
  async preservationMetrics() {
    const [heldSources, pendingCopyJobs, gate] = await Promise.all([
      this.db.db.collection('ReportHolds').aggregate([
        { $match: { active: true } }, { $unwind: '$resources' },
        { $group: { _id: '$resources' } }, { $count: 'count' },
      ]).toArray(),
      this.db.db.collection('ReportEvidenceJobs').countDocuments({ state: { $in: ['copy_pending', 'restricted_pending_legal'] } }),
      this.db.db.collection<any>('ReportCoordination').findOne({ _id: 'sources' }),
    ]);
    this.logger.log(JSON.stringify({ metric: 'report_preservation',
      heldSources: heldSources[0]?.count || 0, pendingCopyJobs }));
    if (gate && (!gate.leaseUntil || gate.leaseUntil <= new Date()))
      this.logger.error('report_gate_expired count=1; operator recovery required');
  }
  private setting(name: string, fallback: number, maximum: number) {
    return Math.min(
      maximum,
      Math.max(1, Number(process.env[name]) || fallback),
    );
  }
  constructor(
    @InjectConnection() private readonly db: Connection,
    private readonly storage: S3BucketService,
  ) {}
  async onModuleInit() {
    if (!['off', 'on'].includes(process.env.REPORT_EVIDENCE_COPY || 'off'))
      throw new Error('REPORT_EVIDENCE_COPY must be off or on');
    const mode = process.env.REPORT_INDEXES || 'off';
    if (!['off', 'report', 'apply'].includes(mode))
      throw new Error('REPORT_INDEXES must be off, report or apply');
    if (mode !== 'off') await reportIndexes(this.db, mode === 'apply');
  }
  async intake(reporterId: string, body: unknown) {
    const parsed = reportInput.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException(
        'Invalid report: choose a valid target/category and a note of at most 500 characters',
      );
    const input = parsed.data;
    await this.assertNotProbing(reporterId);
    return preservationGate(this.db, async () => {
      const session = await this.db.startSession();
      let result: any;
      try {
        await session.withTransaction(async () => {
          const reports = this.db.db.collection<any>('Reports');
          const key = {
            reporterId,
            targetType: input.targetType,
            targetId: input.targetId,
            open: true,
          };
          const existing = await reports.findOne(key, { session });
          if (existing) {
            result = {
              reportId: existing.reportId,
              status: existing.status,
              targetOwnerId: existing.targetOwnerId,
            };
            return;
          }
          const now = new Date();
          if (
            (await reports.countDocuments(
              {
                reporterId,
                createdAt: { $gt: new Date(now.getTime() - 3600000) },
              },
              { session },
            )) >= this.setting('REPORT_USER_HOURLY_LIMIT', 10, 100) ||
            (await reports.countDocuments(
              {
                reporterId,
                targetType: input.targetType,
                targetId: input.targetId,
                createdAt: { $gt: new Date(now.getTime() - 86400000) },
              },
              { session },
            )) >= this.setting('REPORT_TARGET_DAILY_LIMIT', 3, 100)
          )
            throw new HttpException(
              'Too many reports; please try again later',
              429,
            );
          const source = await readReportSource(
            this.db,
            this.storage,
            reporterId,
            input,
            session,
          );
          const reportId = randomUUID(),
            evidenceId = randomUUID();
          const restricted =
            input.category === 'underage' ||
            input.childSafetySuspected === true;
          const reporter = await this.db.db
            .collection('Users')
            .findOne({ _id: new Types.ObjectId(reporterId) }, { session });
          const policy = await this.db.db
            .collection('ReportReporterPolicies')
            .findOne({ _id: reporterId } as any, { session });
          const eligible =
            !!reporter?.isEmailVerified &&
            !policy?.excluded &&
            !policy?.abusive &&
            !policy?.spam;
          const record: any = {
            _id: reportId,
            reportId,
            ...key,
            targetOwnerId: source.owner,
            category: input.category,
            details: sanitizeReportText(input.details),
            status: 'open',
            evidenceSnapshotRefs: [evidenceId],
            conversationId: source.conversationId,
            messageId: source.messageId,
            createdAt: now,
            assignedModerator: null,
            resolution: null,
            resolvedAt: null,
            legalHold: false,
            restricted,
            priority: restricted ? 'highest' : 'normal',
            eligible,
          };
          await reports.insertOne(record, { session });
          await this.db.db
            .collection<any>(
              restricted ? 'RestrictedReportEvidence' : 'ReportEvidence',
            )
            .insertOne(
              {
                _id: evidenceId,
                reportId,
                restricted,
                snapshot: source.snapshot,
                context: source.context,
                createdAt: now,
                images: source.keys.map((sourceKey, index) => ({
                  evidenceId: `${evidenceId}-${index}`,
                  sourceKey,
                  state: restricted
                    ? 'restricted_pending_legal'
                    : 'copy_pending',
                })),
              },
              { session },
            );
          await this.db.db.collection<any>('ReportHolds').insertOne(
            {
              _id: reportId,
              reportId,
              active: true,
              resources: source.resources,
              createdAt: now,
            },
            { session },
          );
          for (const [index, sourceKey] of source.keys.entries()) {
            const imageId = `${evidenceId}-${index}`;
            await this.db.db.collection<any>('ReportEvidenceJobs').insertOne(
              {
                _id: imageId,
                reportId,
                evidenceId,
                imageId,
                sourceKey,
                restricted,
                // No restricted storage prefix is allocated without legal approval.
                destinationKey: restricted
                  ? null
                  : `reports/${reportId}/${imageId}.jpg`,
                state: restricted ? 'restricted_pending_legal' : 'copy_pending',
                attempts: 0,
                dueAt: now,
              },
              { session },
            );
          }
          if (restricted) {
            // Only an eligible (verified, non-abusive) reporter can hide content
            // instantly; otherwise one throwaway account could take anyone down.
            // Every child-safety report still enters the highest-priority queue.
            if (eligible)
              await this.db.db.collection<any>('RestrictedContent').updateOne(
                { _id: `${source.collection}:${source.sourceId}` },
                {
                  $setOnInsert: {
                    collection: source.collection,
                    contentId: source.sourceId,
                    ownerId: source.owner,
                    reportId,
                    createdAt: now,
                  },
                },
                { upsert: true, session },
              );
            await this.db.db.collection<any>('StaffAuditLog').insertOne(
              {
                actorId: 'system',
                role: 'system',
                action: eligible
                  ? 'restricted_preservation_escalated'
                  : 'restricted_report_queued_unverified',
                reportId,
                targetUserId: source.owner,
                contentId: source.sourceId,
                reason: eligible
                  ? 'Child-safety intake; admin/root review required'
                  : 'Child-safety intake from ineligible reporter; content not hidden pending review',
                timestamp: now,
              },
              { session },
            );
          }
          // A system receipt contains no target, category, note, reporter ID or evidence.
          await this.db.db.collection('Notifications').insertOne(
            {
              receiver: new Types.ObjectId(reporterId),
              sender: null,
              type: 'report_receipt',
              message: 'We received your report',
              metadata: { reportReceipt: true, reportId },
              createdAt: now,
              isRead: false,
            },
            { session },
          );
          const rows = await reports
            .find(
              {
                targetOwnerId: source.owner,
                eligible: true,
                createdAt: {
                  $gte: new Date(
                    now.getTime() -
                      this.setting('REPORT_REVIEW_WINDOW_DAYS', 7, 365) *
                        86400000,
                  ),
                },
              },
              { session },
            )
            .toArray();
          const excluded = await this.db.db
            .collection<any>('ReportReporterPolicies')
            .find(
              { $or: [{ excluded: true }, { abusive: true }, { spam: true }] },
              { session },
            )
            .toArray();
          const distinct = new Set(
            rows
              .map((row) => row.reporterId)
              .filter((id) => !excluded.some((policy) => policy._id === id)),
          );
          if (
            restricted ||
            (eligible && input.category === 'nudity_sexual') ||
            distinct.size >=
              this.setting('REPORT_REVIEW_DISTINCT_THRESHOLD', 5, 100)
          ) {
            const previous = await this.db.db
              .collection<any>('ReportReviewQueue')
              .findOne({ _id: source.owner }, { session });
            const restrictedQueue = restricted || previous?.restricted === true;
            await this.db.db.collection<any>('ReportReviewQueue').updateOne(
              { _id: source.owner },
              {
                $set: {
                  targetOwnerId: source.owner,
                  distinctEligibleReporters: distinct.size,
                  restricted: restrictedQueue,
                  priority: restrictedQueue ? 'highest' : 'normal',
                  updatedAt: now,
                },
                $setOnInsert: { createdAt: now },
              },
              { upsert: true, session },
            );
          }
          result = { reportId, status: 'open', targetOwnerId: source.owner };
        }, REPORT_TRANSACTION);
      } catch (error) {
        if ([403, 404].includes(error.getStatus?.()))
          await this.recordFailedAttempt(reporterId);
        if (error.getStatus?.() === 429) {
          const policies = this.db.db.collection<any>('ReportReporterPolicies'),
            day = Math.floor(Date.now() / 86400000);
          await policies.updateOne(
            { _id: reporterId },
            [
              {
                $set: {
                  rateLimitDay: day,
                  rateLimitHits: {
                    $cond: [
                      { $eq: ['$rateLimitDay', day] },
                      { $add: [{ $ifNull: ['$rateLimitHits', 0] }, 1] },
                      1,
                    ],
                  },
                },
              },
              {
                $set: {
                  abusive: {
                    $or: [
                      { $ifNull: ['$abusive', false] },
                      {
                        $gte: [
                          '$rateLimitHits',
                          this.setting('REPORT_ABUSE_LIMIT_HITS', 10, 100),
                        ],
                      },
                    ],
                  },
                },
              },
            ],
            { upsert: true },
          );
        }
        // Driver errors may include failed document contents. Never hand those
        // to Nest's exception logger or the client.
        if (error instanceof HttpException) throw error;
        throw new ServiceUnavailableException('Report could not be saved; please try again');
      } finally {
        await session.endSession();
      }
      return result;
    });
  }
  /**
   * Rejected intakes (404 missing / 403 no access) insert no Report, so the
   * per-report limits never see them. Cap them separately: otherwise the
   * 404-vs-403 difference lets a script enumerate private content IDs.
   */
  private async assertNotProbing(reporterId: string) {
    const policy = await this.db.db
      .collection<any>('ReportReporterPolicies')
      .findOne({ _id: reporterId });
    if (
      policy?.failedHour === Math.floor(Date.now() / 3600000) &&
      policy.failedHits >= this.setting('REPORT_FAILED_HOURLY_LIMIT', 20, 200)
    )
      throw new HttpException('Too many reports; please try again later', 429);
  }
  private async recordFailedAttempt(reporterId: string) {
    const hour = Math.floor(Date.now() / 3600000);
    await this.db.db.collection<any>('ReportReporterPolicies').updateOne(
      { _id: reporterId },
      [
        {
          $set: {
            failedHour: hour,
            failedHits: {
              $cond: [
                { $eq: ['$failedHour', hour] },
                { $add: [{ $ifNull: ['$failedHits', 0] }, 1] },
                1,
              ],
            },
          },
        },
      ],
      { upsert: true },
    );
  }
  async mine(reporterId: string, before?: string, requestedLimit = 20) {
    const limit = Math.min(100, Math.max(1, Number(requestedLimit) || 20));
    // Report IDs are random UUIDs, so page newest-first by createdAt with the
    // ID as a tiebreak. The cursor is opaque to the client.
    const cursor = decodeReportCursor(before);
    const rows = await this.db.db
      .collection<any>('Reports')
      .find(
        {
          reporterId,
          ...(cursor
            ? {
                $or: [
                  { createdAt: { $lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, _id: { $lt: cursor.id } },
                ],
              }
            : {}),
        } as any,
        { projection: { _id: 0, reportId: 1, status: 1, createdAt: 1 } },
      )
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .toArray();
    const last = rows[limit - 1];
    return {
      reports: rows.slice(0, limit),
      nextCursor: rows.length > limit ? encodeReportCursor(last) : null,
    };
  }
  async notices(reporterId: string) {
    return this.db.db
      .collection('Notifications')
      .find(
        {
          receiver: new Types.ObjectId(reporterId),
          sender: null,
          $or: [{ 'metadata.reportReceipt': true }, { 'metadata.systemNotice': true }],
        },
        {
          projection: {
            _id: 0,
            message: 1,
            createdAt: 1,
            'metadata.reportId': 1,
          },
        },
      )
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();
  }
  /** Multi-instance safe: the same DB gate serializes copy, retention and deletion. */
  @Cron(CronExpression.EVERY_MINUTE)
  async processEvidence() {
    if ((process.env.REPORT_EVIDENCE_COPY || 'off') !== 'on') return;
    await preservationGate(this.db, async () => {
      const jobs = this.db.db.collection<any>('ReportEvidenceJobs');
      for (const job of await jobs
        .find({
          restricted: false,
          state: 'copy_pending',
          dueAt: { $lte: new Date() },
        })
        .limit(20)
        .toArray()) {
        const report = await this.db.db
          .collection<any>('Reports')
          .findOne({ _id: job.reportId });
        if (
          !report ||
          report.restricted ||
          !(await this.db.db
            .collection<any>('ReportHolds')
            .findOne({ _id: job.reportId, active: true }))
        )
          continue;
        try {
          await this.storage.copyReportEvidence(
            job.sourceKey,
            job.destinationKey,
          );
          await jobs.updateOne(
            { _id: job._id, state: 'copy_pending' },
            { $set: { state: 'copied', copiedAt: new Date() } },
          );
          await this.db.db.collection<any>('ReportEvidence').updateOne(
            { _id: job.evidenceId, 'images.evidenceId': job.imageId },
            {
              $set: {
                'images.$.state': 'copied',
                'images.$.s3Key': job.destinationKey,
              },
            },
          );
        } catch {
          await jobs.updateOne(
            { _id: job._id },
            {
              $inc: { attempts: 1 },
              $set: {
                dueAt: new Date(
                  Date.now() +
                    Math.min(3600000, 60000 * 2 ** Math.min(job.attempts, 6)),
                ),
              },
            },
          );
        }
      }
    });
  }
  @Cron(CronExpression.EVERY_HOUR)
  async retainEvidence() {
    await preservationGate(this.db, async () => {
      const days = Math.max(1, Number(process.env.REPORT_RETENTION_DAYS) || 90);
      const cutoff = new Date(Date.now() - days * 86400000);
      const reports = this.db.db.collection<any>('Reports');
      const eligible = {
        status: { $in: ['actioned', 'dismissed'] },
        open: false,
        legalHold: false,
        restricted: false,
        resolvedAt: { $lte: cutoff },
        evidencePurgedAt: { $exists: false },
      };
      for (const candidate of await reports
        .find(eligible)
        .limit(20)
        .toArray()) {
        const jobs = await this.db.db
          .collection<any>('ReportEvidenceJobs')
          .find({ reportId: candidate.reportId })
          .toArray();
        // While copying is enabled, wait for pending copies. With copying off they
        // can never complete: skipping them kept holds active forever, so the
        // reported user's deleted photos were never removed. Copies run under this
        // same gate, so only 'copied' jobs have an evidence object to delete.
        if (
          (process.env.REPORT_EVIDENCE_COPY || 'off') === 'on' &&
          jobs.some((job) => job.state === 'copy_pending')
        )
          continue;
        // Re-read status/hold immediately before EACH irreversible storage delete.
        for (const job of jobs.filter((row) => row.state === 'copied')) {
          if (!(await reports.findOne({ _id: candidate._id, ...eligible })))
            break;
          await this.storage.deleteOne(job.destinationKey);
        }
        const session = await this.db.startSession();
        try {
          await session.withTransaction(async () => {
            if (
              !(await reports.findOne(
                { _id: candidate._id, ...eligible },
                { session },
              ))
            )
              return;
            await this.db.db
              .collection('ReportEvidence')
              .deleteMany({ reportId: candidate.reportId }, { session });
            await this.db.db
              .collection('ReportEvidenceJobs')
              .deleteMany({ reportId: candidate.reportId }, { session });
            await this.db.db
              .collection('ReportHolds')
              .updateOne(
                { reportId: candidate.reportId },
                { $set: { active: false, releasedAt: new Date() } },
                { session },
              );
            await reports.updateOne(
              { _id: candidate._id },
              {
                $set: { evidencePurgedAt: new Date() },
                $unset: { details: '', evidenceSnapshotRefs: '' },
              },
              { session },
            );
          }, REPORT_TRANSACTION);
        } finally {
          await session.endSession();
        }
      }
    });
  }
}
