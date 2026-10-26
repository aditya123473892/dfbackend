import { createConnection, Connection, Types } from 'mongoose';
import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { PassportModule } from '@nestjs/passport';
import { JwtService } from '@nestjs/jwt';
import request = require('supertest');
import { ReportsService } from './reports.service';
import { ReportsController } from './reports.controller';
import { reportIndexes } from './report-indexes';
import { readReportSource, recordReportAccess } from './evidence-reader';
import { preservationGate, preserveMutation, recoverPreservationGate } from './preservation';
import { restrictionFilter } from './restricted-content';
import { BlockService } from '../user-blocks/block.service';
import { blockIndexes } from '../user-blocks/block-indexes';
import { blockContext, blockQueryPlugin } from '../user-blocks/block-context';
import { ChatService } from '../chats/chats.service';
import { ChatGateway } from '../chats/chats.gateway';
import { PostsService } from '../posts/posts.service';
import { EventsService } from '../events/events.service';
import { PhotosService } from '../photos/photos.service';
import { S3BucketService } from '../s3-bucket/s3-bucket.service';
import { JwtStrategy } from '../common/guards/jwt.strategy';
import { ResponseInterceptor } from '../common/interceptors';
import { UsersSchema, PostsSchema } from '../common/schemas';
import { ChatMessageSchema } from '../common/schemas/chats.schema';
import { EventsSchema } from '../common/schemas/events.schema';
import { GroupSchema } from '../common/schemas/group-chat.schema';
import { groupServiceFor } from '../user-blocks/block.fixture';
import { NotificationService } from '../notification/notification.service';
import { PostsController } from '../posts/posts.controller';
import { EventsController } from '../events/events.controller';
import { ChatsController } from '../chats/chats.controller';
import { UsersService } from '../users/users.service';
import { MailService } from '../mail/mail.service';
import { Logger } from '@nestjs/common';

const integration = process.env.TEST_MONGO_URI ? describe : describe.skip;
integration('Phase 2 report preservation', () => {
  let db: Connection,
    reports: ReportsService,
    blocks: BlockService,
    storage: any,
    app: any;
  const name = `darkfantasy_reports_test_${randomUUID().replace(/-/g, '')}`;
  const a = new Types.ObjectId(),
    b = new Types.ObjectId(),
    c = new Types.ObjectId(),
    group = new Types.ObjectId();
  const post = new Types.ObjectId(),
    event = new Types.ObjectId(),
    message = new Types.ObjectId(),
    media = new Types.ObjectId();
  const key = 'chat/source/image.jpg';
  const models: any = {};
  const jwt = new JwtService({ secret: `reports-test-${randomUUID()}` });
  const body = (targetType = 'chat_message', targetId = String(message)) => ({
    targetType,
    targetId,
    category: 'harassment',
  });
  const chats = () =>
    new ChatService(
      models.ChatMessage,
      models.Users,
      models.Group,
      { create: jest.fn() } as any,
      {} as any,
      new PhotosService(db, storage),
      blocks,
    );
  beforeAll(async () => {
    db = await createConnection(process.env.TEST_MONGO_URI, {
      dbName: name,
      autoIndex: false,
    }).asPromise();
    db.plugin(blockQueryPlugin);
    for (const [label, schema] of Object.entries({
      Users: UsersSchema,
      Posts: PostsSchema,
      ChatMessage: ChatMessageSchema,
      Events: EventsSchema,
      Group: GroupSchema,
    }))
      models[label] = db.model(label, (schema as any).clone());
    blocks = new BlockService(db);
    await blockIndexes(db, true, () => {});
    await reportIndexes(db, true, () => {});
    storage = {
      keyFromReference: (value: string) =>
        value && !value.includes('://') ? value : undefined,
      copyReportEvidence: jest.fn(),
      deleteOne: jest.fn(),
      keysUnder: jest.fn().mockResolvedValue([]),
    };
    reports = new ReportsService(db, storage);
    const module = await Test.createTestingModule({
      imports: [PassportModule.register({ defaultStrategy: 'jwt' })],
      controllers: [ReportsController, PostsController, EventsController, ChatsController],
      providers: [
        { provide: ChatService, useFactory: chats },
        { provide: PhotosService, useValue: new PhotosService(db, storage) },
        { provide: PostsService, useValue: new PostsService(models.Posts, {} as any, {} as any, {} as any, {} as any, {} as any) },
        { provide: EventsService, useValue: new EventsService(models.Events, {} as any) },
        { provide: ChatGateway, useValue: { broadcastSavedMessage: jest.fn() } },
        { provide: S3BucketService, useValue: storage },
        { provide: UsersService, useValue: {} },
        { provide: MailService, useValue: {} },
        { provide: ReportsService, useValue: reports },
        {
          provide: JwtStrategy,
          useValue: new JwtStrategy(
            { get: () => (jwt as any).options.secret } as any,
            db,
          ),
        },
      ],
    }).compile();
    app = module.createNestApplication();
    app.use((_req, _res, next) => blockContext.run({}, next));
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();
  });
  beforeEach(async () => {
    for (const collection of await db.db.collections())
      await collection.deleteMany({});
    process.env.REPORT_EVIDENCE_COPY = 'off';
    delete process.env.REPORT_RETENTION_DAYS;
    jest.clearAllMocks();
    await db.db.collection('Users').insertMany(
      [a, b, c].map((_id) => ({
        _id,
        displayname: String(_id),
        roles: ['user'],
        isEmailVerified: true,
        isBlocked: false,
        createdAt: new Date(0),
      })),
    );
    await db.db.collection('Groups').insertOne({
      _id: group,
      name: 'Shared',
      admin: a,
      members: [a, b],
      createdAt: new Date(0),
    });
    await db.db.collection('Posts').insertOne({
      _id: post,
      user: a,
      caption: 'Original post',
      __v: 0,
      status: 'approved',
      visibility: 'public',
      media: [{ filename: 'posts/original.jpg' }],
    });
    await db.db.collection('Events').insertOne({
      _id: event,
      creator: a,
      name: 'Event',
      description: 'Original event',
      cover: { filename: 'events/original.jpg' },
    });
    await db.db.collection('ChatMessages').insertOne({
      _id: message,
      sender: a,
      receiver: b,
      message: 'Original message',
      sentAt: new Date(100000),
      media: [
        {
          _id: media,
          storageKey: key,
          mimetype: 'image/jpeg',
          checksum: 'ok',
          status: 'active',
        },
      ],
    });
    await db.db.collection<any>('PhotoUploads').insertOne({
      _id: randomUUID(),
      owner: String(a),
      key,
      state: 'attached',
      ref: `chat:${message}`,
      createdAt: new Date(0),
      expiresAt: new Date(100000),
    });
  });
  afterAll(async () => {
    delete process.env.REPORT_EVIDENCE_COPY;
    if (app) await app.close();
    await db.dropDatabase();
    await db.close();
  });

  it.each([
    [a, b],
    [b, a],
  ])(
    'reports direct messages and profiles after either direction blocks (%s)',
    async (blocker, blocked) => {
      await blocks.block(String(blocker), String(blocked));
      const result = await reports.intake(String(b), body());
      expect(result.status).toBe('open');
      const profile = await reports.intake(
        String(blocked),
        body('user', String(blocker)),
      );
      expect(profile.status).toBe('open');
    },
  );
  it('uses prior visible post and event receipts after blocking without user-facing history or signing', async () => {
    for (const [collection, id] of [
      ['Posts', post],
      ['Events', event],
    ] as const)
      await recordReportAccess(db, String(b), collection, String(id));
    await blocks.block(String(a), String(b));
    expect(
      (await reports.intake(String(b), body('post', String(post)))).status,
    ).toBe('open');
    expect(
      (await reports.intake(String(b), body('event', String(event)))).status,
    ).toBe('open');
    expect(storage.copyReportEvidence).not.toHaveBeenCalled();
  });
  it('rejects a conversation the reporter was never in, including a group that they can name', async () => {
    await expect(reports.intake(String(c), body())).rejects.toThrow(
      'We could not verify your prior access',
    );
    await db.db
      .collection('ChatMessages')
      .updateOne(
        { _id: message },
        { $set: { groupId: group }, $unset: { receiver: '' } },
      );
    await expect(reports.intake(String(c), body())).rejects.toThrow(
      'We could not verify your prior access',
    );
    expect(await db.db.collection('Reports').countDocuments({})).toBe(0);
  });
  it('retains former group membership proof and excludes messages sent after removal', async () => {
    await db.db
      .collection('ChatMessages')
      .updateOne(
        { _id: message },
        { $set: { groupId: group }, $unset: { receiver: '' } },
      );
    await groupServiceFor(models.Group, blocks).removeMembers(
      { groupId: String(group), members: [String(b)] },
      String(a),
    );
    expect((await reports.intake(String(b), body())).status).toBe('open');
    const later = new Types.ObjectId();
    await db.db.collection('ChatMessages').insertOne({
      _id: later,
      groupId: group,
      sender: a,
      message: 'Later',
      sentAt: new Date(Date.now() + 60000),
    });
    await expect(
      reports.intake(String(b), body('chat_message', String(later))),
    ).rejects.toThrow('We could not verify your prior access');
  });
  it('snapshots exactly twenty preceding messages of only the reported conversation', async () => {
    const rows: any[] = [];
    for (let i = 0; i < 25; i++)
      rows.push({
        sender: a,
        receiver: b,
        message: `context-${i}`,
        sentAt: new Date(1000 + i),
      });
    rows.push(
      {
        sender: a,
        receiver: c,
        message: 'foreign secret',
        sentAt: new Date(50000),
      },
      { sender: a, receiver: b, message: 'future', sentAt: new Date(200000) },
    );
    await db.db.collection('ChatMessages').insertMany(rows);
    const result = await reports.intake(String(b), body());
    const evidence = await db.db
      .collection('ReportEvidence')
      .findOne({ reportId: result.reportId });
    expect(evidence.context.map((row) => row.message)).toEqual(
      Array.from({ length: 20 }, (_, i) => `context-${i + 5}`),
    );
    expect(evidence.snapshot.message).toBe('Original message');
    expect(
      evidence.context.every(
        (row) => row.contentId && row.senderId && row.timestamp,
      ),
    ).toBe(true);
  });
  it('deduplicates concurrent intake atomically with one snapshot, hold, job and system receipt', async () => {
    const saved = await Promise.all(
      Array.from({ length: 4 }, () => reports.intake(String(b), body())),
    );
    expect(new Set(saved.map((row) => row.reportId)).size).toBe(1);
    for (const collection of [
      'Reports',
      'ReportEvidence',
      'ReportHolds',
      'ReportEvidenceJobs',
      'Notifications',
    ])
      expect(await db.db.collection(collection).countDocuments({})).toBe(1);
  });
  it('rolls back report, evidence, hold and receipt together when intake fails', async () => {
    // MongoDB validator is an actual transactional failure, independent of mocks.
    await db.db.command({
      collMod: 'ReportHolds',
      validator: { impossible: { $exists: true } },
      validationLevel: 'strict',
    });
    try {
      await expect(reports.intake(String(b), body())).rejects.toThrow();
      for (const label of [
        'Reports',
        'ReportEvidence',
        'ReportHolds',
        'ReportEvidenceJobs',
        'Notifications',
      ])
        expect(await db.db.collection(label).countDocuments({})).toBe(0);
    } finally {
      await db.db.command({ collMod: 'ReportHolds', validator: {} });
    }
  });
  it('enforces ten per user per hour and three per reporter-target per day after dedupe', async () => {
    await db.db.collection<any>('Reports').insertMany(
      Array.from({ length: 10 }, () => ({
        _id: randomUUID(),
        reporterId: String(b),
        targetType: 'user',
        targetId: String(new Types.ObjectId()),
        createdAt: new Date(),
        open: false,
      })),
    );
    await expect(reports.intake(String(b), body())).rejects.toMatchObject({
      status: 429,
    });
    await db.db.collection('Reports').deleteMany({});
    await db.db.collection<any>('Reports').insertMany(
      Array.from({ length: 3 }, () => ({
        _id: randomUUID(),
        reporterId: String(b),
        targetType: 'chat_message',
        targetId: String(message),
        createdAt: new Date(),
        open: false,
      })),
    );
    await expect(reports.intake(String(b), body())).rejects.toMatchObject({
      status: 429,
    });
  });
  it('validates with Zod, rejects forged identities and self-reporting, and escapes the optional note', async () => {
    for (const value of [
      { ...body(), details: 'a'.repeat(501) },
      { ...body(), reporterId: String(a) },
      { ...body(), category: 'invalid' },
      { ...body(), targetId: '../../vault/key' },
    ])
      await expect(reports.intake(String(b), value)).rejects.toMatchObject({
        status: 400,
      });
    await expect(reports.intake(String(a), body())).rejects.toThrow(
      'own content',
    );
    const saved = await reports.intake(String(b), {
      ...body(),
      details: '<script>"\u0000&</script>',
    });
    const row = await db.db
      .collection<any>('Reports')
      .findOne({ _id: saved.reportId });
    expect(row.details).toBe('&lt;script&gt;&quot;&amp;&lt;/script&gt;');
  });
  it('stores pending image jobs while off, retries idempotently when on, and keeps the source hold', async () => {
    const saved = await reports.intake(String(b), body());
    await reports.processEvidence();
    expect(storage.copyReportEvidence).not.toHaveBeenCalled();
    expect(
      (
        await db.db
          .collection('ReportEvidenceJobs')
          .findOne({ reportId: saved.reportId })
      ).state,
    ).toBe('copy_pending');
    process.env.REPORT_EVIDENCE_COPY = 'on';
    storage.copyReportEvidence.mockRejectedValueOnce(
      new Error('IAM not deployed'),
    );
    await reports.processEvidence();
    const failed = await db.db
      .collection('ReportEvidenceJobs')
      .findOne({ reportId: saved.reportId });
    expect(failed.attempts).toBe(1);
    await db.db
      .collection('ReportEvidenceJobs')
      .updateOne({ _id: failed._id }, { $set: { dueAt: new Date(0) } });
    await reports.processEvidence();
    await reports.processEvidence();
    expect(storage.copyReportEvidence).toHaveBeenCalledTimes(2);
    expect(storage.copyReportEvidence.mock.calls[0]).toEqual(
      storage.copyReportEvidence.mock.calls[1],
    );
    expect(
      (
        await db.db
          .collection('ReportHolds')
          .findOne({ reportId: saved.reportId })
      ).active,
    ).toBe(true);
    expect(
      (
        await db.db
          .collection('ReportEvidence')
          .findOne({ reportId: saved.reportId })
      ).images[0].state,
    ).toBe('copied');
  });
  it.each([
    'sender delete',
    'media revoke',
    'media expiry',
    'post delete',
    'event delete',
    'expired media cleanup',
    'durable photo cleanup',
    'account purge',
  ])('preserves evidence against concurrent %s', async (path) => {
    const type =
      path === 'post delete'
        ? 'post'
        : path === 'event delete'
          ? 'event'
          : 'chat_message';
    const id =
      type === 'post'
        ? String(post)
        : type === 'event'
          ? String(event)
          : String(message);
    let release: () => void, entered: () => void;
    const started = new Promise<void>((resolve) => (entered = resolve)),
      wait = new Promise<void>((resolve) => (release = resolve));
    const intake = preservationGate(db, async () => {
      const saved = await reports.intake(String(b), body(type, id));
      entered();
      await wait;
      return saved;
    });
    await started;
    const photos = new PhotosService(db, storage);
    let deletion: Promise<any>;
    if (path === 'sender delete')
      deletion = chats().deleteMessage(String(message), String(a));
    else if (path === 'media revoke')
      deletion = chats().revokeMedia(String(a), String(message), String(media));
    else if (path === 'media expiry')
      deletion = chats().updateMediaExpiration(
        String(a),
        String(message),
        String(media),
        new Date(Date.now() + 60000).toISOString(),
      );
    else if (path === 'post delete')
      deletion = new PostsService(
        models.Posts,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      ).remove(String(post));
    else if (path === 'event delete')
      deletion = new EventsService(models.Events, {} as any).remove(
        String(event),
      );
    else if (path === 'account purge')
      deletion = (photos as any).purgeAccount(String(a));
    else {
      await db.db
        .collection('PhotoDeletionJobs')
        .insertOne({ key, dueAt: new Date(0), attempts: 0 });
      await db.db.collection('ChatMessages').updateOne(
        { _id: message },
        {
          $set: {
            'media.0.status':
              path === 'expired media cleanup' ? 'active' : 'revoked',
            'media.0.expiresAt':
              path === 'expired media cleanup'
                ? new Date(0)
                : new Date(Date.now() + 60000),
          },
        },
      );
      deletion = photos.cleanup();
    }
    const outcome = deletion.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    release();
    const saved = await intake,
      result: any = await outcome;
    expect(result.error).toBeUndefined();
    expect(storage.deleteOne).not.toHaveBeenCalledWith(key);
    const sourceCollection =
      type === 'post' ? 'Posts' : type === 'event' ? 'Events' : 'ChatMessages';
    const remaining = await db.db.collection(sourceCollection).findOne({ _id: new Types.ObjectId(id) });
    if (['sender delete', 'post delete', 'event delete', 'account purge'].includes(path))
      expect(remaining).toBeNull();
    else expect(remaining).not.toBeNull();
    expect(
      await db.db
        .collection('ReportEvidence')
        .findOne({ reportId: saved.reportId }),
    ).not.toBeNull();
  });
  it('keeps copied evidence independent of a later sender delete/revoke and never purges cases with the account', async () => {
    const saved = await reports.intake(String(b), body());
    process.env.REPORT_EVIDENCE_COPY = 'on';
    await reports.processEvidence();
    await db.db
      .collection('ChatMessages')
      .updateOne(
        { _id: message },
        { $set: { message: 'changed', 'media.0.status': 'revoked' } },
      );
    await db.db.collection('ChatMessages').deleteOne({ _id: message });
    expect(
      (
        await db.db
          .collection('ReportEvidence')
          .findOne({ reportId: saved.reportId })
      ).snapshot.message,
    ).toBe('Original message');
    await (new PhotosService(db, storage) as any).purgeAccount(String(a));
    expect(
      await db.db.collection<any>('Reports').findOne({ _id: saved.reportId }),
    ).not.toBeNull();
  });
  it('keeps missing-message and blocked-pair authorization ahead of preservation conflicts', async () => {
    await reports.intake(String(b), body());
    await expect(
      chats().deleteMessage(String(message), String(c)),
    ).rejects.toThrow('Message not found');
    await blocks.block(String(a), String(b));
    await expect(
      chats().deleteMessage(String(message), String(a)),
    ).rejects.toThrow('Message not found');
    await expect(
      chats().revokeMedia(String(a), String(message), String(media)),
    ).rejects.toThrow('Message not found');
  });
  it('restricts and hides child-safety content immediately without signing, copying or download routes', async () => {
    const saved = await reports.intake(String(b), {
      ...body(),
      category: 'underage',
    });
    process.env.REPORT_EVIDENCE_COPY = 'on';
    await reports.processEvidence();
    expect(storage.copyReportEvidence).not.toHaveBeenCalled();
    expect(await db.db.collection('ReportEvidence').countDocuments({})).toBe(0);
    expect(
      await db.db
        .collection('RestrictedReportEvidence')
        .countDocuments({ reportId: saved.reportId }),
    ).toBe(1);
    expect(await models.ChatMessage.findById(message)).toBeNull();
    const emitted = jest.fn(),
      service = chats(),
      gateway = new ChatGateway(service, jwt, {} as any, blocks);
    gateway.server = { to: () => ({ emit: emitted }) } as any;
    await gateway.broadcastSavedMessage({
      _id: message,
      sender: a,
      receiver: b,
    });
    expect(emitted).not.toHaveBeenCalled();
    await expect(
      service.getMediaAccessUrl(String(b), String(message), String(media)),
    ).rejects.toThrow();
    const job = await db.db
      .collection('ReportEvidenceJobs')
      .findOne({ reportId: saved.reportId });
    expect(job.destinationKey).toBeNull();
    expect(job.state).toBe('restricted_pending_legal');
    expect(
      (await db.db.collection('Users').findOne({ _id: a })).isBlocked,
    ).toBe(false);
    await reports.intake(String(c), {
      ...body('user', String(a)),
      category: 'nudity_sexual',
    });
    expect(
      (
        await db.db
          .collection('ReportReviewQueue')
          .findOne({ targetOwnerId: String(a) })
      ).restricted,
    ).toBe(true);
    expect(
      (
        await db.db
          .collection('StaffAuditLog')
          .findOne({ reportId: saved.reportId })
      ).action,
    ).toBe('restricted_preservation_escalated');
  });
  it('hides a restricted profile without disabling owner authentication or granting another viewer an exemption', async () => {
    await reports.intake(String(b), {
      ...body('user', String(a)),
      category: 'underage',
    });
    await blockContext.run({ viewerId: String(a), authSelf: true }, async () =>
      expect(await models.Users.findById(a)).not.toBeNull(),
    );
    await blockContext.run({ viewerId: String(b), authSelf: true }, async () =>
      expect(await models.Users.findById(a)).toBeNull(),
    );
    await blockContext.run({ viewerId: String(a) }, async () =>
      expect(await models.Users.findById(a)).toBeNull(),
    );
    await new PhotosService(db, storage).assertActiveAccount(String(a));
  });
  it('does not auto-hide ordinary or nudity reports and uses distinct eligible reporters for review', async () => {
    await reports.intake(String(b), {
      ...body('user', String(a)),
      category: 'nudity_sexual',
    });
    expect(await db.db.collection('RestrictedContent').countDocuments({})).toBe(
      0,
    );
    expect(
      await db.db
        .collection('ReportReviewQueue')
        .findOne({ targetOwnerId: String(a) }),
    ).not.toBeNull();
    await db.db.collection('ReportReviewQueue').deleteMany({});
    await db.db.collection('Reports').deleteMany({});
    const voters = Array.from({ length: 5 }, () => new Types.ObjectId());
    await db.db
      .collection('Users')
      .insertMany(voters.map((_id) => ({ _id, isEmailVerified: true })));
    for (const voter of voters.slice(0, 4))
      await reports.intake(String(voter), body('user', String(a)));
    await reports.intake(String(voters[0]), body('user', String(a)));
    expect(await db.db.collection('ReportReviewQueue').countDocuments({})).toBe(
      0,
    );
    await reports.intake(String(voters[4]), body('user', String(a)));
    expect(
      (
        await db.db
          .collection('ReportReviewQueue')
          .findOne({ targetOwnerId: String(a) })
      ).distinctEligibleReporters,
    ).toBe(5);
  });
  it('invalidates restricted content anonymously across backend watchers with no reporter or case payload', async () => {
    await blocks.onModuleInit();
    const second = new BlockService(db);
    await second.onModuleInit();
    const firstPayloads: any[] = [],
      secondPayloads: any[] = [];
    const first = blocks.restrictedChanges$.subscribe((value) =>
      firstPayloads.push(value),
    );
    const other = second.restrictedChanges$.subscribe((value) =>
      secondPayloads.push(value),
    );
    try {
      // Ensure watch cursors are registered before the committed marker.
      await new Promise((resolve) => setTimeout(resolve, 100));
      await reports.intake(String(b), {
        ...body(),
        childSafetySuspected: true,
      });
      const deadline = Date.now() + 3000;
      while (
        (!firstPayloads.length || !secondPayloads.length) &&
        Date.now() < deadline
      )
        await new Promise((resolve) => setTimeout(resolve, 25));
      expect(firstPayloads).toEqual([undefined]);
      expect(secondPayloads).toEqual([undefined]);
      const emit = jest.fn(),
        gateway = new ChatGateway(
          chats(),
          jwt,
          { accountDeletion$: { subscribe: jest.fn() } } as any,
          blocks,
        );
      gateway.afterInit({
        local: { emit },
        use: jest.fn(),
        to: () => ({ emit: jest.fn() }),
        in: () => ({ disconnectSockets: jest.fn(), socketsLeave: jest.fn() }),
      } as any);
      blocks.restrictedChanges$.next();
      expect(emit.mock.calls).toEqual([['visibilityChanged']]);
    } finally {
      first.unsubscribe();
      other.unsubscribe();
      await second.onModuleDestroy();
      await blocks.onModuleDestroy();
    }
  });
  it('ignores spam/abusive reporters for ordinary review weighting', async () => {
    await db.db
      .collection<any>('ReportReporterPolicies')
      .insertOne({ _id: String(b), abusive: true });
    await reports.intake(String(b), {
      ...body('user', String(a)),
      category: 'nudity_sexual',
    });
    expect(await db.db.collection('ReportReviewQueue').countDocuments({})).toBe(
      0,
    );
  });
  it('flags repeated rate-limit abuse for staff review without banning or hiding the user', async () => {
    await db.db.collection<any>('Reports').insertMany(
      Array.from({ length: 10 }, () => ({
        _id: randomUUID(),
        reporterId: String(b),
        createdAt: new Date(),
        open: false,
      })),
    );
    for (let i = 0; i < 10; i++)
      await expect(reports.intake(String(b), body())).rejects.toMatchObject({
        status: 429,
      });
    const policy = await db.db
      .collection<any>('ReportReporterPolicies')
      .findOne({ _id: String(b) });
    expect(policy.abusive).toBe(true);
    expect(policy.rateLimitHits).toBe(10);
    expect(
      (await db.db.collection('Users').findOne({ _id: b })).isBlocked,
    ).toBe(false);
    expect(await db.db.collection('RestrictedContent').countDocuments({})).toBe(
      0,
    );
  });
  it('requires verified JWT identity on intake and rejects HTTP identity injection', async () => {
    expect(
      (await request(app.getHttpServer()).post('/reports').send(body())).status,
    ).toBe(401);
    const auth = `Bearer ${jwt.sign({ sub: String(b) })}`;
    const forged = await request(app.getHttpServer())
      .post('/reports')
      .set('Authorization', auth)
      .send({ ...body(), reporterId: String(a) });
    expect(forged.status).toBe(400);
    const accepted = await request(app.getHttpServer())
      .post('/reports')
      .set('Authorization', auth)
      .send(body());
    expect(accepted.status).toBe(201);
    expect(accepted.body.data.reporterId).toBeUndefined();
    expect((await db.db.collection('Reports').findOne({})).reporterId).toBe(
      String(b),
    );
  });
  it('isolates reporter identity from targets/participants, sockets and notices; internal evidence has no route', async () => {
    await db.db
      .collection('Groups')
      .updateOne({ _id: group }, { $set: { members: [a, b, c] } });
    await db.db
      .collection('ChatMessages')
      .updateOne(
        { _id: message },
        { $set: { groupId: group }, $unset: { receiver: '' } },
      );
    const emit = jest.fn(),
      original = ChatGateway.prototype.broadcastSavedMessage;
    const spy = jest
      .spyOn(ChatGateway.prototype, 'broadcastSavedMessage')
      .mockImplementation(emit);
    try {
      const saved = await reports.intake(String(b), body());
      for (const user of [a, c]) {
        const auth = `Bearer ${jwt.sign({ sub: String(user) })}`;
        const own = await request(app.getHttpServer())
          .get('/reports/me')
          .set('Authorization', auth);
        expect(own.body.data.reports).toEqual([]);
        const notices = await request(app.getHttpServer())
          .get('/reports/notices')
          .set('Authorization', auth);
        expect(notices.body.data).toEqual([]);
        for (const path of [
          `/reports/${saved.reportId}`,
          `/reports/${saved.reportId}/evidence`,
          '/reports/internal',
          '/reports/evidence',
          '/reports/read-source',
        ])
          expect(
            (
              await request(app.getHttpServer())
                .get(path)
                .set('Authorization', auth)
            ).status,
          ).toBe(404);
      }
      expect(emit).not.toHaveBeenCalled();
      const mine = await reports.mine(String(b));
      expect(Object.keys(mine.reports[0]).sort()).toEqual([
        'createdAt',
        'reportId',
        'status',
      ]);
      const notice = await db.db.collection('Notifications').findOne({});
      expect(notice.sender).toBeNull();
      expect(notice.metadata).toEqual({
        reportReceipt: true,
        reportId: saved.reportId,
      });
      expect(JSON.stringify(notice.metadata)).not.toContain(String(b));
      await blocks.block(String(a), String(b));
      expect(await reports.notices(String(b))).toHaveLength(1);
      await new NotificationService(
        db.model(
          'Notification',
          new (require('mongoose').Schema)(
            {},
            { collection: 'Notifications', strict: false },
          ),
        ),
        blocks,
      ).sendNotification(
        String(b),
        String(a),
        'event_message' as any,
        'denied',
      );
      expect(await db.db.collection('Notifications').countDocuments({})).toBe(
        1,
      );
    } finally {
      spy.mockRestore();
    }
  });
  it('releases holds of expired resolved cases when evidence copying is off, deleting no evidence bytes', async () => {
    const saved = await reports.intake(String(b), body());
    await db.db
      .collection<any>('Reports')
      .updateOne(
        { _id: saved.reportId },
        { $set: { status: 'dismissed', open: false, resolvedAt: new Date(0) } },
      );
    await reports.retainEvidence();
    expect(storage.deleteOne).not.toHaveBeenCalled();
    expect(
      await db.db.collection('ReportEvidence').countDocuments({ reportId: saved.reportId }),
    ).toBe(0);
    expect(
      (await db.db.collection('ReportHolds').findOne({ reportId: saved.reportId })).active,
    ).toBe(false);
  });
  it('retains unresolved, legal-held, restricted and pending-copy evidence; purges eligible evidence after ninety days', async () => {
    process.env.REPORT_EVIDENCE_COPY = 'on';
    const saved = await reports.intake(String(b), body());
    await reports.retainEvidence();
    expect(storage.deleteOne).not.toHaveBeenCalled();
    await db.db
      .collection<any>('Reports')
      .updateOne(
        { _id: saved.reportId },
        { $set: { status: 'dismissed', open: false, resolvedAt: new Date(0) } },
      );
    await reports.retainEvidence();
    expect(storage.deleteOne).not.toHaveBeenCalled();
    await reports.processEvidence();
    await db.db
      .collection<any>('Reports')
      .updateOne({ _id: saved.reportId }, { $set: { legalHold: true } });
    await reports.retainEvidence();
    expect(storage.deleteOne).not.toHaveBeenCalled();
    await db.db
      .collection<any>('Reports')
      .updateOne(
        { _id: saved.reportId },
        { $set: { legalHold: false, restricted: true } },
      );
    await reports.retainEvidence();
    expect(storage.deleteOne).not.toHaveBeenCalled();
    await db.db
      .collection<any>('Reports')
      .updateOne({ _id: saved.reportId }, { $set: { restricted: false } });
    await reports.retainEvidence();
    expect(storage.deleteOne).toHaveBeenCalledTimes(1);
    expect(
      await db.db
        .collection('ReportEvidence')
        .countDocuments({ reportId: saved.reportId }),
    ).toBe(0);
    expect(
      (
        await db.db
          .collection('ReportHolds')
          .findOne({ reportId: saved.reportId })
      ).active,
    ).toBe(false);
  });
  it('rechecks a changed legal hold after selecting a retention candidate and before deleting bytes', async () => {
    const saved = await reports.intake(String(b), body());
    process.env.REPORT_EVIDENCE_COPY = 'on';
    await reports.processEvidence();
    await db.db
      .collection<any>('Reports')
      .updateOne(
        { _id: saved.reportId },
        { $set: { status: 'dismissed', open: false, resolvedAt: new Date(0) } },
      );
    const original = db.db.collection.bind(db.db);
    const spy = jest.spyOn(db.db, 'collection').mockImplementation(((
      name: string,
      ...options: any[]
    ) => {
      const collection: any = original(name, ...options);
      if (name !== 'Reports') return collection;
      return new Proxy(collection, {
        get(target, property) {
          if (property === 'find')
            return (...args: any[]) => {
              const cursor = target.find(...args),
                toArray = cursor.toArray.bind(cursor);
              cursor.toArray = async () => {
                const rows = await toArray();
                await original('Reports').updateOne(
                  { reportId: saved.reportId },
                  { $set: { legalHold: true } },
                );
                return rows;
              };
              return cursor;
            };
          const value = target[property];
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    }) as any);
    try {
      await reports.retainEvidence();
    } finally {
      spy.mockRestore();
    }
    expect(storage.deleteOne).not.toHaveBeenCalled();
    expect(
      (
        await db.db
          .collection('ReportHolds')
          .findOne({ reportId: saved.reportId })
      ).active,
    ).toBe(true);
  });
  it.each(['post', 'event', 'media'])('returns byte-identical HTTP success for %s deletion with or without a hold', async (type) => {
    // Keep the frozen clock near MongoDB's real heartbeat time. Restoring a clock
    // frozen months in the past makes Mongoose treat a healthy connection as stale.
    const now = new Date();
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'hrtime'] });
    jest.setSystemTime(now);
    try {
      const collection = type === 'post' ? 'Posts' : type === 'event' ? 'Events' : 'ChatMessages';
      const id = type === 'post' ? post : type === 'event' ? event : message;
      const original = await db.db.collection(collection).findOne({ _id: id });
      if (type === 'event') await db.db.collection('Users').updateOne({ _id: a }, { $set: { roles: ['admin'] } });
      const auth = `Bearer ${jwt.sign({ sub: String(a) })}`;
      const requestDelete = () => type === 'media'
        ? request(app.getHttpServer()).patch(`/chats/messages/${message}/media/${media}/revoke`).set('Authorization', auth)
        : request(app.getHttpServer()).delete(`/${type === 'post' ? 'posts' : 'events'}/${id}`).set('Authorization', auth);
      const normal = await requestDelete();
      expect(normal.status).toBe(200);
      const normalEvents = JSON.stringify(app.get(ChatGateway).broadcastSavedMessage.mock.calls);
      app.get(ChatGateway).broadcastSavedMessage.mockClear();
      await db.db.collection(collection).replaceOne({ _id: id }, original, { upsert: true });
      await reports.intake(String(b), body(type === 'media' ? 'chat_message' : type, String(id)));
      const held = await requestDelete();
      expect(held.status).toBe(normal.status);
      expect(held.text).toBe(normal.text);
      expect(JSON.stringify(app.get(ChatGateway).broadcastSavedMessage.mock.calls)).toBe(normalEvents);
      await new PhotosService(db, storage).cleanup();
      expect(storage.deleteOne).not.toHaveBeenCalledWith(type === 'post' ? 'posts/original.jpg' : type === 'event' ? 'events/original.jpg' : key);
      expect(await db.db.collection('ReportEvidence').countDocuments({})).toBe(1);
      if (type === 'media') await expect(chats().getMediaAccessUrl(String(b), String(message), String(media))).rejects.toThrow();
      else expect(await db.db.collection(collection).findOne({ _id: id })).toBeNull();
    } finally { jest.useRealTimers(); }
  });
  it('emits identical messageDeleted socket payloads with and without a hold and removes user-visible history', async () => {
    const original = await db.db.collection('ChatMessages').findOne({ _id: message });
    const deliveries: any[] = [];
    const gateway = new ChatGateway(chats(), jwt, {} as any, blocks);
    jest.spyOn(gateway, 'broadcastSavedMessage').mockImplementation(async (payload, event) => { deliveries.push({ payload, event }); });
    const client: any = { data: { userId: String(a) }, emit: jest.fn() };
    await gateway.handleDeleteMessage({ messageId: String(message) }, client);
    await db.db.collection('ChatMessages').insertOne(original);
    await reports.intake(String(b), body());
    await gateway.handleDeleteMessage({ messageId: String(message) }, client);
    expect(deliveries).toHaveLength(2);
    expect(JSON.stringify(deliveries[1])).toBe(JSON.stringify(deliveries[0]));
    expect(deliveries[1].event).toBe('messageDeleted');
    expect(client.emit).not.toHaveBeenCalled();
    expect(await models.ChatMessage.findById(message)).toBeNull();
    expect(storage.deleteOne).not.toHaveBeenCalled();
  });
  it.each([a, b])('purges non-evidence account data on schedule for target or reporter %s without stalling', async (owner) => {
    const saved = await reports.intake(String(b), body());
    await db.db.collection<any>('AccountPurges').insertOne({ _id: String(owner), dueAt: new Date(0), attempts: 0 });
    await new PhotosService(db, storage).cleanup();
    expect(await db.db.collection('Users').findOne({ _id: owner })).toBeNull();
    expect(await db.db.collection<any>('AccountPurges').findOne({ _id: String(owner) })).toBeNull();
    expect(await db.db.collection('ChatMessages').findOne({ _id: message })).toBeNull();
    expect(await db.db.collection('Notifications').countDocuments({ receiver: owner })).toBe(0);
    expect(await db.db.collection<any>('Reports').findOne({ _id: saved.reportId })).not.toBeNull();
    expect((await db.db.collection('ReportEvidence').findOne({ reportId: saved.reportId })).snapshot.message).toBe('Original message');
    expect(storage.deleteOne).not.toHaveBeenCalledWith(key);
  });
  it('keeps the original profile bio and photo snapshot after edits, replacement cleanup and account purge', async () => {
    await db.db.collection('Users').updateOne({ _id: a }, { $set: { bio: 'Original bio', avatar: 'profile/original.jpg' } });
    const saved = await reports.intake(String(b), body('user', String(a)));
    await db.db.collection('Users').updateOne({ _id: a }, { $set: { bio: 'New bio', avatar: 'profile/new.jpg' } });
    await (new PhotosService(db, storage) as any).purgeAccount(String(a));
    const evidence = await db.db.collection('ReportEvidence').findOne({ reportId: saved.reportId });
    expect(evidence.snapshot.bio).toBe('Original bio');
    expect(evidence.snapshot.profilePhotos).toEqual(['profile/original.jpg']);
    await new PhotosService(db, storage).enqueue(['profile/original.jpg']);
    await new PhotosService(db, storage).cleanup();
    expect(storage.deleteOne).not.toHaveBeenCalledWith('profile/original.jpg');
  });
  it('returns a generic prior-access error without leaking the group or membership history', async () => {
    await db.db.collection('ChatMessages').updateOne({ _id: message }, { $set: { groupId: group }, $unset: { receiver: '' } });
    const result = await request(app.getHttpServer()).post('/reports').set('Authorization', `Bearer ${jwt.sign({ sub: String(c) })}`).send(body());
    expect(result.status).toBe(403);
    expect(result.body).toEqual({ statusCode: 403, message: 'We could not verify your prior access to this conversation. Please contact support.', error: 'Forbidden' });
    expect(result.text).not.toContain(String(group));
    expect(result.text).not.toContain(String(a));
  });
  it('alerts on expired gate and retries durable cleanup/account purge after explicit fenced recovery', async () => {
    const token = randomUUID();
    await db.db.collection<any>('ReportCoordination').insertOne({ _id: 'sources', token, leaseUntil: new Date(0) });
    const errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    const warning = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      await reports.preservationMetrics();
      expect(errorLog).toHaveBeenCalledWith('report_gate_expired count=1; operator recovery required');
      // No live reference; this cleanup must encounter the busy gate.
      await db.db.collection('PhotoDeletionJobs').insertOne({ key: 'orphan.jpg', dueAt: new Date(0), attempts: 0 });
      await db.db.collection<any>('AccountPurges').insertOne({ _id: String(a), dueAt: new Date(0), attempts: 0 });
      const photos = new PhotosService(db, storage);
      await photos.cleanup();
      expect((await db.db.collection('PhotoDeletionJobs').findOne({ key: 'orphan.jpg' })).attempts).toBe(1);
      expect((await db.db.collection<any>('AccountPurges').findOne({ _id: String(a) })).attempts).toBe(1);
      expect(storage.deleteOne).not.toHaveBeenCalled();
      await expect(recoverPreservationGate(db, 'wrong')).rejects.toThrow('recovery denied');
      await recoverPreservationGate(db, token);
      expect(warning).toHaveBeenCalledWith('report_gate_operator_recovery count=1');
      await db.db.collection('PhotoDeletionJobs').updateMany({}, { $set: { dueAt: new Date(0) } });
      await db.db.collection('AccountPurges').updateMany({}, { $set: { dueAt: new Date(0) } });
      await photos.cleanup();
      expect(await db.db.collection<any>('AccountPurges').findOne({ _id: String(a) })).toBeNull();
      expect(storage.deleteOne).toHaveBeenCalledWith('orphan.jpg');
    } finally { errorLog.mockRestore(); log.mockRestore(); warning.mockRestore(); }
  }, 30000);
  it('emits counts only and never logs or returns report text, image keys or signed URLs', async () => {
    const note = '<script>secret & "note"</script>';
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    try {
      const saved = await reports.intake(String(b), { ...body(), details: note });
      await reports.preservationMetrics();
      const stored = await db.db.collection<any>('Reports').findOne({ _id: saved.reportId });
      expect(stored.details).toBe('&lt;script&gt;secret &amp; &quot;note&quot;&lt;/script&gt;');
      const output = JSON.stringify([await reports.mine(String(b)), await reports.notices(String(b)), log.mock.calls]);
      for (const secret of [note, stored.details, key, 'https://']) expect(output).not.toContain(secret);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('"pendingCopyJobs":1'));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('"heldSources":'));
    } finally { log.mockRestore(); }
  });
  it('creates a renewable lease and refuses recovery of a live holder', async () => {
    await preservationGate(db, async () => {
      const gate = await db.db.collection<any>('ReportCoordination').findOne({ _id: 'sources' });
      expect(gate.leaseUntil.getTime()).toBeGreaterThan(Date.now());
      await expect(recoverPreservationGate(db, gate.token)).rejects.toThrow('lease is still active');
    });
    expect(await db.db.collection<any>('ReportCoordination').findOne({ _id: 'sources' })).toBeNull();
  });
  it('redacts failed report documents from HTTP driver errors', async () => {
    await db.db.command({ collMod: 'ReportHolds', validator: { impossible: { $exists: true } }, validationLevel: 'strict' });
    try {
      const result = await request(app.getHttpServer()).post('/reports').set('Authorization', `Bearer ${jwt.sign({ sub: String(b) })}`).send({ ...body(), details: 'private-driver-error-text' });
      expect(result.status).toBe(503);
      expect(result.body.message).toBe('Report could not be saved; please try again');
      expect(result.text).not.toContain('private-driver-error-text');
      expect(await db.db.collection('Reports').countDocuments({})).toBe(0);
    } finally { await db.db.command({ collMod: 'ReportHolds', validator: {}, validationLevel: 'off' }); }
  });
  it('keeps message-delete ack and error shapes identical with and without a preservation hold', async () => {
    const gateway = new ChatGateway(chats(), jwt, {} as any, blocks);
    jest.spyOn(gateway, 'broadcastSavedMessage').mockResolvedValue(undefined);
    const client: any = { data: { userId: String(c) }, emit: jest.fn() };
    const command = { messageId: String(message) };
    const normalAck = await gateway.handleDeleteMessage(command, client);
    const normalErrors = JSON.stringify(client.emit.mock.calls);
    expect(normalAck).toBeUndefined();
    await reports.intake(String(b), body());
    client.emit.mockClear();
    expect(await gateway.handleDeleteMessage(command, client)).toBe(normalAck);
    expect(JSON.stringify(client.emit.mock.calls)).toBe(normalErrors);
    expect(client.emit.mock.calls).toEqual([['error', { statusCode: 404, message: 'Message not found' }]]);
    client.data.userId = String(a);
    expect(await gateway.handleDeleteMessage(command, client)).toBeUndefined();
  });
  it.each(['open', 'escalated', 'restricted', 'legalHold'])('does not delete held account-purge bytes for %s cases', async (state) => {
    const saved = await reports.intake(String(b), body());
    await db.db.collection<any>('Reports').updateOne({ _id: saved.reportId }, { $set: state === 'restricted' || state === 'legalHold' ? { [state]: true } : { status: state } });
    await (new PhotosService(db, storage) as any).purgeAccount(String(a));
    const photos = new PhotosService(db, storage);
    await photos.cleanup();
    await reports.retainEvidence();
    await photos.cleanup();
    expect(storage.deleteOne).not.toHaveBeenCalledWith(key);
    expect(await db.db.collection('PhotoDeletionJobs').findOne({ key })).not.toBeNull();
    expect((await db.db.collection<any>('ReportHolds').findOne({ _id: saved.reportId })).active).toBe(true);
  });
  it('reports a comment only when its parent post is visible to the reporter', async () => {
    const comment = new Types.ObjectId(),
      hidden = new Types.ObjectId(),
      privatePost = new Types.ObjectId();
    await db.db.collection('Posts').insertOne({
      _id: privatePost,
      user: a,
      status: 'approved',
      visibility: 'private',
      media: [],
    });
    await db.db.collection('Comments').insertMany([
      { _id: comment, user: a, post, content: 'Original comment' },
      { _id: hidden, user: a, post: privatePost, content: 'Hidden comment' },
    ]);
    const saved = await reports.intake(String(b), body('comment', String(comment)));
    expect(saved.targetOwnerId).toBe(String(a));
    const evidence = await db.db
      .collection<any>('ReportEvidence')
      .findOne({ reportId: saved.reportId });
    expect(evidence.snapshot.content).toBe('Original comment');
    await expect(
      reports.intake(String(b), body('comment', String(hidden))),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      reports.intake(String(a), body('comment', String(comment))),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      reports.intake(String(b), body('comment', String(new Types.ObjectId()))),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('hides child-safety targets instantly only for eligible reporters; every such report is queued', async () => {
    await db.db
      .collection('Users')
      .updateOne({ _id: b }, { $set: { isEmailVerified: false } });
    const unverified = await reports.intake(String(b), {
      targetType: 'user',
      targetId: String(a),
      category: 'underage',
    });
    expect(await db.db.collection('RestrictedContent').countDocuments({})).toBe(0);
    expect(
      await db.db.collection<any>('Reports').findOne({ _id: unverified.reportId }),
    ).toMatchObject({ restricted: true, priority: 'highest', eligible: false });
    expect(
      await db.db.collection<any>('ReportReviewQueue').findOne({ _id: String(a) }),
    ).toMatchObject({ restricted: true, priority: 'highest' });
    await reports.intake(String(c), {
      targetType: 'user',
      targetId: String(a),
      category: 'underage',
    });
    expect(
      await db.db.collection<any>('RestrictedContent').countDocuments({ _id: `Users:${a}` }),
    ).toBe(1);
  });
  it('rate-limits rejected intakes so private content IDs cannot be enumerated', async () => {
    process.env.REPORT_FAILED_HOURLY_LIMIT = '2';
    try {
      for (let i = 0; i < 2; i++)
        await expect(
          reports.intake(String(b), body('post', String(new Types.ObjectId()))),
        ).rejects.toMatchObject({ status: 404 });
      expect(await db.db.collection('Reports').countDocuments({})).toBe(0);
      // Even a valid target is refused until the window passes.
      await expect(reports.intake(String(b), body())).rejects.toMatchObject({
        status: 429,
      });
      expect(await db.db.collection('Reports').countDocuments({})).toBe(0);
      expect((await reports.intake(String(c), body('post', String(post)))).status).toBe('open');
    } finally {
      delete process.env.REPORT_FAILED_HOURLY_LIMIT;
    }
  });
  it('lists My reports newest first across pages although report IDs are random', async () => {
    const rows = [3, 1, 4, 2, 5].map((minute) => ({
      _id: randomUUID(),
      reportId: '',
      reporterId: String(b),
      status: 'open',
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, minute)),
    }));
    rows.forEach((row) => (row.reportId = row._id));
    await db.db.collection<any>('Reports').insertMany(rows);
    const first = await reports.mine(String(b), undefined, 2);
    const second = await reports.mine(String(b), first.nextCursor!, 2);
    const third = await reports.mine(String(b), second.nextCursor!, 2);
    const minutes = [...first.reports, ...second.reports, ...third.reports].map(
      (row: any) => new Date(row.createdAt).getUTCMinutes(),
    );
    expect(minutes).toEqual([5, 4, 3, 2, 1]);
    expect(third.nextCursor).toBeNull();
  });
});
