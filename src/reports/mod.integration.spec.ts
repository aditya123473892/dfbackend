import { createConnection, Connection, Types } from 'mongoose';
import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { getConnectionToken } from '@nestjs/mongoose';
import { PassportModule } from '@nestjs/passport';
import { JwtService } from '@nestjs/jwt';
import request = require('supertest');
import { ModController } from './mod.controller';
import { ModService } from './mod.service';
import { StaffAuditService } from './staff-audit.service';
import { ModCaseGuard, ModFeatureGuard, verifyModConfiguration } from './mod.guard';
import { ReportsService } from './reports.service';
import { reportIndexes } from './report-indexes';
import { blockContext, blockQueryPlugin } from '../user-blocks/block-context';
import { BlockService } from '../user-blocks/block.service';
import { JwtStrategy } from '../common/guards/jwt.strategy';
import { ResponseInterceptor } from '../common/interceptors';
import { PhotosService } from '../photos/photos.service';
import { PhotoResponseInterceptor } from '../photos/response.interceptor';
import { VaultService } from '../vault/vault.service';
import { VaultController } from '../vault/vault.controller';
import { UsersService } from '../users/users.service';
import { UsersController } from '../users/users.controller';
import { UsersSchema } from '../common/schemas/users.schema';
import { ChatMessageSchema } from '../common/schemas/chats.schema';
import { S3BucketService } from '../s3-bucket/s3-bucket.service';
import { MailService } from '../mail/mail.service';
import { changeRoles, validateRoles } from '../users/role-policy';
import { ChatGateway } from '../chats/chats.gateway';
import { AuthService } from '../auth/auth.service';

const integration = process.env.TEST_MONGO_URI ? describe : describe.skip;
integration('Phase 3 moderation authorization and case workflow', () => {
  let db: Connection, app: any, mod: ModService, audit: StaffAuditService, reports: ReportsService,
    blocks: BlockService, photos: PhotosService, users: UsersService, storage: any, userModel: any, chatModel: any, reportId: string;
  const ids = Object.fromEntries(['user', 'manager', 'moderator', 'admin', 'root', 'root2', 'target'].map((role) => [role, new Types.ObjectId()]));
  const message = new Types.ObjectId(), media = new Types.ObjectId(), key = 'chat/mod-test/image.jpg';
  const jwt = new JwtService({ secret: `mod-test-${randomUUID()}` });
  const actor = (role: string) => ({ id: String(ids[role]), roles: [role === 'root2' ? 'root' : role] });
  const auth = (role: string, extra = {}) => `Bearer ${jwt.sign({ sub: String(ids[role]), roles: ['root'], ...extra })}`;
  const note = { note: 'Reviewed against policy' };
  const review = () => mod.mutate(actor('moderator'), reportId, 'transition', { status: 'in_review', revision: 0, ...note });
  beforeAll(async () => {
    db = await createConnection(process.env.TEST_MONGO_URI, { dbName: `mod_test_${randomUUID().replace(/-/g, '')}`, autoIndex: false }).asPromise();
    db.plugin(blockQueryPlugin);
    userModel = db.model('Users', UsersSchema.clone());
    chatModel = db.model('ChatMessage', ChatMessageSchema.clone());
    await reportIndexes(db, true, () => {});
    blocks = new BlockService(db);
    storage = { keyFromReference: (value) => value, copyReportEvidence: jest.fn(), signReportEvidence: jest.fn().mockResolvedValue('https://private.test/evidence'),
      readVerified: jest.fn().mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff])), deleteOne: jest.fn(), keysUnder: jest.fn().mockResolvedValue([]), getSignedURL: jest.fn() };
    photos = new PhotosService(db, storage);
    reports = new ReportsService(db, storage);
    audit = new StaffAuditService(db);
    mod = new ModService(db, storage, audit, blocks);
    users = new UsersService(userModel, {} as any, {} as any, {} as any, {} as any, {} as any, chatModel, blocks);
    const module = await Test.createTestingModule({ imports: [PassportModule.register({ defaultStrategy: 'jwt' })],
      controllers: [ModController, UsersController, VaultController], providers: [
        { provide: getConnectionToken(), useValue: db },
        { provide: ModService, useValue: mod }, { provide: ModFeatureGuard, useValue: new ModFeatureGuard() },
        { provide: ModCaseGuard, useValue: new ModCaseGuard(db) }, { provide: UsersService, useValue: users },
        { provide: PhotosService, useValue: photos }, { provide: S3BucketService, useValue: storage },
        { provide: MailService, useValue: {} }, { provide: VaultService, useValue: new VaultService(db, storage, photos) },
        { provide: JwtStrategy, useValue: new JwtStrategy({ get: () => (jwt as any).options.secret } as any, db) },
      ] }).compile();
    app = module.createNestApplication();
    app.use((_req, _res, next) => blockContext.run({}, next));
    app.useGlobalInterceptors(new ResponseInterceptor(), new PhotoResponseInterceptor(photos));
    await app.init();
  });
  beforeEach(async () => {
    for (const collection of await db.db.collections()) await collection.deleteMany({});
    process.env.MOD_API_ENABLED = 'on';
    process.env.REPORT_EVIDENCE_COPY = 'off';
    jest.clearAllMocks();
    await db.db.collection('Users').insertMany(Object.entries(ids).map(([role, _id]) => ({ _id, roles: [role === 'target' ? 'user' : role === 'root2' ? 'root' : role], isBlocked: false, isEmailVerified: true, username: `${role}@test.invalid` })));
    await db.db.collection('ChatMessages').insertOne({ _id: message, sender: ids.target, receiver: ids.user, message: '<script>content</script>',
      sentAt: new Date(), media: [{ _id: media, storageKey: key, checksum: 'ok', mimetype: 'image/jpeg' }] });
    reportId = (await reports.intake(String(ids.user), { targetType: 'chat_message', targetId: String(message), category: 'harassment', details: '<script>note</script>' })).reportId;
  });
  afterAll(async () => {
    delete process.env.MOD_API_ENABLED; delete process.env.REPORT_EVIDENCE_COPY;
    await app?.close(); await db.dropDatabase(); await db.close();
  });
  it.each([['anonymous', 401], ['user', 403], ['manager', 403], ['moderator', 200], ['admin', 200], ['root', 200]])('RolesGuard /mod matrix %s -> %s', async (role, status) => {
    const routes = [['get', '/mod/reports'], ['get', '/mod/review-queue'], ['get', `/mod/reports/${reportId}`],
      ['patch', `/mod/reports/${reportId}/assignment`], ['patch', `/mod/reports/${reportId}/status`],
      ['post', `/mod/reports/${reportId}/actions`], ['patch', `/mod/reports/${reportId}/legal-hold`],
      ['post', `/mod/reports/${reportId}/evidence/unknown/view`]];
    for (const [method, path] of routes) {
      const req = request(app.getHttpServer())[method](path);
      if (role !== 'anonymous') req.set('Authorization', auth(role));
      const expected = status !== 200 ? status : method === 'get' ? 200
        : role === 'moderator' && path.endsWith('legal-hold') ? 403 : 400;
      expect((await req.send({})).status).toBe(expected);
    }
  });
  it('returns the nonexistent-route response when disabled, before authentication', async () => {
    process.env.MOD_API_ENABLED = 'off';
    const off = await request(app.getHttpServer()).get('/mod/reports');
    const missing = await request(app.getHttpServer()).get('/missing');
    expect(off.status).toBe(missing.status);
    expect(off.body).toEqual({ ...missing.body, message: 'Cannot GET /mod/reports' });
    expect((await request(app.getHttpServer()).get('/mod/reports').set('Authorization', auth('root'))).text).toBe(off.text);
  });
  it('uses DB roles despite forged/stale token roles and demotion applies on the next request', async () => {
    expect((await request(app.getHttpServer()).get('/mod/reports').set('Authorization', auth('user'))).status).toBe(403);
    expect((await request(app.getHttpServer()).get('/mod/reports').set('Authorization', auth('moderator'))).status).toBe(200);
    await db.db.collection('Users').updateOne({ _id: ids.moderator }, { $set: { roles: ['user'] } });
    expect((await request(app.getHttpServer()).get('/mod/reports').set('Authorization', auth('moderator'))).status).toBe(403);
  });
  it('enforces role hierarchy, rejects self role changes and validates every role enum item', async () => {
    const update = (role, target, roles) => request(app.getHttpServer()).patch(`/users/update/${ids[target]}`).set('Authorization', auth(role)).send({ roles });
    expect((await update('moderator', 'target', ['moderator'])).status).toBe(403);
    expect((await update('admin', 'target', ['root'])).status).toBe(403);
    expect((await update('admin', 'root', ['user'])).status).toBe(403);
    expect((await update('root', 'root', ['user'])).status).toBe(403);
    expect((await request(app.getHttpServer()).patch(`/users/update/${String(ids.root).toUpperCase()}`).set('Authorization', auth('root')).send({ roles: ['user'] })).status).toBe(403);
    expect((await update('root', 'target', ['invented'])).status).toBe(400);
    expect((await update('admin', 'target', ['moderator'])).status).toBe(200);
    expect((await update('root', 'target', ['admin'])).status).toBe(200);
    expect(() => validateRoles(['user', 'invented'])).toThrow('Invalid roles');
    const doc = new userModel({ username: 'valid@test.invalid', displayname: 'Valid', firstName: 'A', lastName: 'B', password: 'secret', roles: ['user', 'invented'] });
    expect(doc.validateSync()?.errors.roles || doc.validateSync()?.errors['roles.1']).toBeDefined();
    const createBody = { username: 'new-staff@test.invalid', displayname: 'New staff', firstName: 'New', lastName: 'Staff', password: 'safe-test-password', roles: ['root'] };
    expect((await request(app.getHttpServer()).post('/users').set('Authorization', auth('admin')).send(createBody)).status).toBe(403);
    expect((await request(app.getHttpServer()).post('/users').set('Authorization', auth('moderator')).send(createBody)).status).toBe(403);
  });
  it('protects the last active root under serialized concurrent demotions', async () => {
    // The first root cannot demote itself; parallel attempts against the other
    // root leave an active root even when retried or token roles are stale.
    const results = await Promise.allSettled([
      changeRoles(db, String(ids.root), String(ids.root2), ['user'] as any),
      changeRoles(db, String(ids.root2), String(ids.root), ['user'] as any),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await db.db.collection('Users').countDocuments({ roles: 'root' })).toBe(1);
  });
  it('keeps /mod independent of pair blocks without granting another-user vault access', async () => {
    await db.db.collection('UserBlocks').insertOne({ blockerId: ids.target, blockedId: ids.moderator });
    const caseResponse = await request(app.getHttpServer()).get(`/mod/reports/${reportId}`).set('Authorization', auth('moderator'));
    expect(caseResponse.status).toBe(200);
    expect(caseResponse.headers['cache-control']).toBe('private, no-store');
    expect(JSON.stringify(caseResponse.body)).not.toContain('reporterId');
    expect(caseResponse.body.data.evidence[0].snapshot.message).toBe('&lt;script&gt;content&lt;/script&gt;');
    const photoId = randomUUID();
    await db.db.collection('VaultPhotos').insertOne({ owner: String(ids.target), id: photoId, key: `vault/${ids.target}/${photoId}.jpg`, state: 'approved' });
    expect((await request(app.getHttpServer()).get(`/vault/${photoId}/download-url`).set('Authorization', auth('moderator'))).status).toBe(404);
    expect((await request(app.getHttpServer()).get(`/mod/vault/${photoId}`).set('Authorization', auth('moderator'))).status).toBe(404);
    expect(storage.getSignedURL).not.toHaveBeenCalled();
  });
  it('requires notes, enforces transitions and serializes concurrent case revisions atomically', async () => {
    expect((await request(app.getHttpServer()).patch(`/mod/reports/${reportId}/status`).set('Authorization', auth('moderator')).send({ status: 'in_review', revision: 0 })).status).toBe(400);
    await expect(mod.mutate(actor('moderator'), reportId, 'transition', { status: 'actioned', revision: 0, ...note })).rejects.toMatchObject({ status: 400 });
    const attempts = await Promise.allSettled([review(), review()]);
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await db.db.collection('ReportTransitions').countDocuments({ reportId })).toBe(1);
    await expect(mod.mutate(actor('moderator'), reportId, 'action', { action: 'warn', revision: 0, ...note })).rejects.toMatchObject({ status: 409 });
    await mod.mutate(actor('moderator'), reportId, 'action', { action: 'warn', revision: 1, ...note });
    expect((await mod.detail(actor('moderator'), reportId)).status).toBe('actioned');
  });
  it('requires admin/root for restricted cases, assignment, streams and legal holds; never signs restricted bytes', async () => {
    const restricted = await reports.intake(String(ids.user), { targetType: 'user', targetId: String(ids.target), category: 'underage' });
    // Profile gets an avatar for a separate restricted image intake.
    await db.db.collection('Reports').deleteMany({ reportId: restricted.reportId });
    await db.db.collection('Users').updateOne({ _id: ids.target }, { $set: { avatar: key } });
    const saved = await reports.intake(String(ids.user), { targetType: 'chat_media', targetId: String(media), messageId: String(message), category: 'underage' });
    const job = await db.db.collection('ReportEvidenceJobs').findOne({ reportId: saved.reportId });
    expect((await request(app.getHttpServer()).get(`/mod/reports/${saved.reportId}`).set('Authorization', auth('moderator'))).status).toBe(404);
    expect((await mod.queue(actor('moderator'))).cases.some((row) => row.reportId === saved.reportId)).toBe(false);
    await expect(mod.mutate(actor('moderator'), saved.reportId, 'legal-hold', { legalHold: true, revision: 0, ...note })).rejects.toMatchObject({ status: 404 });
    await expect(mod.mutate(actor('admin'), saved.reportId, 'assign', { moderatorId: String(ids.moderator), revision: 0, ...note })).rejects.toMatchObject({ status: 400 });
    for (const role of ['admin', 'root']) {
      const response = await request(app.getHttpServer()).post(`/mod/reports/${saved.reportId}/evidence/${job.imageId}/view`).set('Authorization', auth(role)).send({ reason: 'case_review' });
      expect(response.status).toBe(201);
      expect(response.headers['content-type']).toContain('image/jpeg');
      expect(response.headers['content-disposition']).toBe('inline');
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.body).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    }
    expect(storage.signReportEvidence).not.toHaveBeenCalled();
    expect(await db.db.collection('StaffAuditLog').countDocuments({ action: 'restricted_evidence_view' })).toBe(2);
    expect((await request(app.getHttpServer()).get(`/mod/reports/${saved.reportId}/download`).set('Authorization', auth('root'))).status).toBe(404);
  });
  it('writes the case audit before issuing a <=60 second ordinary evidence URL and denies on audit failure', async () => {
    process.env.REPORT_EVIDENCE_COPY = 'on'; await reports.processEvidence();
    const job = await db.db.collection('ReportEvidenceJobs').findOne({ reportId });
    storage.signReportEvidence.mockImplementationOnce(async () => {
      expect(await db.db.collection('StaffAuditLog').countDocuments({ reportId, action: 'evidence_view' })).toBe(1);
      return 'https://private.test/evidence';
    });
    const response = await request(app.getHttpServer()).post(`/mod/reports/${reportId}/evidence/${job.imageId}/view`).set('Authorization', auth('moderator')).send({ reason: 'case_review' });
    expect(response.status).toBe(201); expect(response.body.data.expiresIn).toBe(60);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(await db.db.collection('StaffAuditLog').countDocuments({ reportId, s3Key: job.destinationKey })).toBe(1);
    storage.signReportEvidence.mockClear();
    const fail = jest.spyOn(audit, 'append').mockRejectedValueOnce(new Error('audit failed'));
    try { await expect(mod.evidence(actor('moderator'), reportId, job.imageId)).rejects.toThrow('audit failed'); }
    finally { fail.mockRestore(); }
    expect(storage.signReportEvidence).not.toHaveBeenCalled();
    await expect(mod.evidence(actor('moderator'), 'different-case', job.imageId)).rejects.toMatchObject({ status: 404 });
    const rows = await db.db.collection('StaffAuditLog').find({}).toArray();
    expect(JSON.stringify(rows)).not.toContain('https://'); expect(JSON.stringify(rows)).not.toContain('script');
  });
  it('soft-removes content immediately and durable cleanup preserves held bytes', async () => {
    await review();
    await mod.mutate(actor('moderator'), reportId, 'action', { action: 'soft_remove', revision: 1, ...note });
    expect(await chatModel.findById(message)).toBeNull();
    await photos.cleanup();
    expect(storage.deleteOne).not.toHaveBeenCalledWith(key);
    expect(await db.db.collection('PhotoDeletionJobs').findOne({ key })).not.toBeNull();
    // Once the resolved case ages out, the same durable job deletes source bytes.
    process.env.REPORT_EVIDENCE_COPY = 'on'; await reports.processEvidence();
    await db.db.collection<any>('Reports').updateOne({ _id: reportId }, { $set: { resolvedAt: new Date(0) } });
    await reports.retainEvidence();
    await db.db.collection('PhotoDeletionJobs').updateMany({}, { $set: { dueAt: new Date(0) } });
    await photos.cleanup();
    expect(storage.deleteOne).toHaveBeenCalledWith(key);
  });
  it('keeps escalation unresolved until admin acts and denies moderator permanent actions and legal hold', async () => {
    await review();
    for (const action of ['ban', 'delete_account']) await expect(mod.mutate(actor('moderator'), reportId, 'action', { action, revision: 1, ...note })).rejects.toMatchObject({ status: 403 });
    await expect(mod.mutate(actor('moderator'), reportId, 'legal-hold', { legalHold: true, revision: 1, ...note })).rejects.toMatchObject({ status: 403 });
    await mod.mutate(actor('moderator'), reportId, 'action', { action: 'escalate', revision: 1, ...note });
    const escalated = await db.db.collection<any>('Reports').findOne({ _id: reportId });
    expect(escalated.open).toBe(true); expect(escalated.resolvedAt).toBeNull();
    await expect(mod.mutate(actor('moderator'), reportId, 'action', { action: 'dismiss', revision: 2, ...note })).rejects.toMatchObject({ status: 403 });
    await mod.mutate(actor('admin'), reportId, 'action', { action: 'dismiss', revision: 2, ...note });
    expect((await mod.detail(actor('admin'), reportId)).status).toBe('dismissed');
  });
  it('enforces temporary suspension in HTTP authentication and all-device socket disconnect', async () => {
    await review();
    const disconnectSockets = jest.fn();
    const gateway = new ChatGateway({} as any, jwt, photos, blocks);
    gateway.afterInit({ in: () => ({ disconnectSockets }), use: jest.fn(), local: { emit: jest.fn() } } as any);
    await mod.mutate(actor('moderator'), reportId, 'action', { action: 'suspend', suspendedUntil: new Date(Date.now() + 60000).toISOString(), revision: 1, ...note });
    expect(disconnectSockets).toHaveBeenCalledWith(true);
    expect((await request(app.getHttpServer()).get('/users/me').set('Authorization', auth('target'))).status).toBe(401);
    await expect(photos.assertActiveAccount(String(ids.target))).rejects.toMatchObject({ status: 403 });
    const user = await db.db.collection('Users').findOne({ _id: ids.target }); expect(user.isBlocked).toBe(false);
    await db.db.collection('Users').updateOne({ _id: ids.target }, { $set: { moderationSuspendedUntil: new Date(0) } });
    await expect(photos.assertActiveAccount(String(ids.target))).resolves.toBeUndefined();
  });
  it('isolates reporters in case APIs and in-app system-only outcome/policy notices', async () => {
    await review(); await mod.mutate(actor('moderator'), reportId, 'action', { action: 'warn', revision: 1, ...note });
    const targetNotices = await db.db.collection('Notifications').find({ receiver: ids.target }).toArray();
    expect(targetNotices).toHaveLength(1); expect(targetNotices[0].sender).toBeNull();
    expect(targetNotices[0].metadata).toEqual({ systemNotice: true });
    expect(JSON.stringify(targetNotices)).not.toContain(String(ids.user));
    const receipts = await db.db.collection('Notifications').find({ receiver: ids.user, type: 'moderation_notice' }).toArray();
    expect(receipts[0].message).toBe('Action taken'); expect(receipts[0].sender).toBeNull();
    // Even a staff target cannot read its own case or acquire the reporter identity.
    await db.db.collection('Users').updateOne({ _id: ids.target }, { $set: { roles: ['admin'] } });
    expect((await request(app.getHttpServer()).get(`/mod/reports/${reportId}`).set('Authorization', auth('target'))).status).toBe(404);
    expect(JSON.stringify(await mod.detail(actor('moderator'), reportId))).not.toContain('reporterId');
    expect(storage.signReportEvidence).not.toHaveBeenCalled();
  });
  it('refuses production enablement without MFA, short tokens and a dedicated audit credential', () => {
    const before = { ...process.env };
    try {
      process.env.NODE_ENV = 'production'; process.env.MOD_API_ENABLED = 'on';
      delete process.env.STAFF_MFA_ENABLED;
      expect(verifyModConfiguration).toThrow('Production moderation requires');
      Object.assign(process.env, { STAFF_MFA_ENABLED: 'on', STAFF_MFA_ISSUER: 'trusted-staff-issuer', STAFF_TOKEN_TTL_SECONDS: '900', STAFF_AUDIT_DATABASE_URL: 'mongodb://not-used/test' });
      expect(verifyModConfiguration).not.toThrow();
      process.env.STAFF_TOKEN_TTL_SECONDS = '3600'; expect(verifyModConfiguration).toThrow();
      process.env.MOD_API_ENABLED = 'off'; expect(verifyModConfiguration).not.toThrow();
    } finally { process.env = before; }
  });
  it('requires an MFA-authenticated short staff token in production rather than trusting a configuration flag', async () => {
    const before = { ...process.env };
    try {
      Object.assign(process.env, { NODE_ENV: 'production', STAFF_MFA_ISSUER: 'trusted-staff-issuer', STAFF_TOKEN_TTL_SECONDS: '900' });
      expect((await request(app.getHttpServer()).get('/mod/reports').set('Authorization', auth('root'))).status).toBe(403);
      const token = jwt.sign({ sub: String(ids.root), amr: ['mfa'] }, { issuer: 'trusted-staff-issuer', expiresIn: 900 });
      expect((await request(app.getHttpServer()).get('/mod/reports').set('Authorization', `Bearer ${token}`)).status).toBe(200);
      const long = jwt.sign({ sub: String(ids.root), amr: ['mfa'] }, { issuer: 'trusted-staff-issuer', expiresIn: 3600 });
      expect((await request(app.getHttpServer()).get('/mod/reports').set('Authorization', `Bearer ${long}`)).status).toBe(403);
      for (const payload of [{ amr: 'mfa' }, { amr: ['mfa'], iat: Math.floor(Date.now() / 1000) + 3600 }]) {
        const invalid = jwt.sign({ sub: String(ids.root), ...payload }, { issuer: 'trusted-staff-issuer', expiresIn: 900 });
        expect((await request(app.getHttpServer()).get('/mod/reports').set('Authorization', `Bearer ${invalid}`)).status).toBe(403);
      }
    } finally { process.env = before; }
  });
  it('issues short staff tokens without falsely asserting MFA', async () => {
    const authService = new AuthService({} as any, jwt);
    const tokens = await authService.createTokens({ _id: ids.moderator, username: 'mod', roles: ['moderator'] });
    const claims: any = jwt.decode(tokens.accessToken);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(900); expect(claims.amr).toBeUndefined();
  });
  it('denies suspended accounts at password authentication and at socket packet authentication', async () => {
    const authService = new AuthService({ findOneWithPassword: async () => ({ password: 'not-used', roles: ['user'], moderationSuspendedUntil: new Date(Date.now() + 60000) }) } as any, jwt);
    const compare = jest.spyOn(authService, 'comparePassword').mockResolvedValue(true);
    await expect(authService.validateUser('target', 'secret')).rejects.toMatchObject({ status: 401 });
    expect(compare).not.toHaveBeenCalled();
    await db.db.collection('Users').updateOne({ _id: ids.target }, { $set: { moderationSuspendedUntil: new Date(Date.now() + 60000) } });
    const client: any = { data: {}, handshake: { auth: { token: jwt.sign({ sub: String(ids.target) }) } } };
    const gateway = new ChatGateway({ getUserById: () => userModel.findById(ids.target) } as any, jwt, photos, blocks);
    await expect((gateway as any).authenticateClient(client)).rejects.toMatchObject({ status: 403 });
  });
  it('replicates suspension disconnect signals to other backend watchers', async () => {
    const second = new BlockService(db);
    await blocks.onModuleInit(); await second.onModuleInit();
    const firstSignals: string[] = [], secondSignals: string[] = [];
    const firstSub = blocks.suspensionChanges$.subscribe((id) => firstSignals.push(id));
    const secondSub = second.suspensionChanges$.subscribe((id) => secondSignals.push(id));
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await db.db.collection('Users').updateOne({ _id: ids.target }, { $set: { moderationSuspendedUntil: new Date(Date.now() + 60000) } });
      const until = Date.now() + 3000;
      while ((!firstSignals.length || !secondSignals.length) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 25));
      expect(firstSignals).toContain(String(ids.target)); expect(secondSignals).toContain(String(ids.target));
    } finally { firstSub.unsubscribe(); secondSub.unsubscribe(); await blocks.onModuleDestroy(); await second.onModuleDestroy(); }
  });
  it('denies evidence on real audit insert failure and exposes no audit mutation or gate-recovery route', async () => {
    process.env.REPORT_EVIDENCE_COPY = 'on'; await reports.processEvidence();
    const job = await db.db.collection('ReportEvidenceJobs').findOne({ reportId });
    if (!await db.db.listCollections({ name: 'StaffAuditLog' }).hasNext())
      await db.db.createCollection('StaffAuditLog');
    await db.db.command({ collMod: 'StaffAuditLog', validator: { impossible: { $exists: true } }, validationLevel: 'strict' });
    try {
      const response = await request(app.getHttpServer()).post(`/mod/reports/${reportId}/evidence/${job.imageId}/view`).set('Authorization', auth('root')).send({ reason: 'case_review' });
      expect(response.status).toBe(503); expect(storage.signReportEvidence).not.toHaveBeenCalled();
      expect(storage.readVerified).not.toHaveBeenCalled();
    } finally { await db.db.command({ collMod: 'StaffAuditLog', validator: {}, validationLevel: 'off' }); }
    for (const route of ['/mod/audit', '/mod/recover-report-gate', '/reports/recover-report-gate'])
      expect((await request(app.getHttpServer()).post(route).set('Authorization', auth('root')).send({ token: 'not-an-api' })).status).toBe(404);
    expect((audit as any).update).toBeUndefined(); expect((audit as any).delete).toBeUndefined();
  });
  it.each(['ban', 'delete_account'])('allows admin permanent %s actions', async (action) => {
    await review();
    await mod.mutate(actor('admin'), reportId, 'action', { action, revision: 1, ...note });
    const target = await db.db.collection('Users').findOne({ _id: ids.target });
    expect(target.isBlocked).toBe(true);
    if (action === 'delete_account') expect(await db.db.collection<any>('AccountPurges').findOne({ _id: String(ids.target) })).not.toBeNull();
  });
  it('assigns cases with revisions and legal holds only to authorized staff', async () => {
    await mod.mutate(actor('admin'), reportId, 'assign', { moderatorId: String(ids.moderator), revision: 0, ...note });
    expect((await mod.detail(actor('admin'), reportId)).assignedModerator).toBe(String(ids.moderator));
    const unauthorized = await request(app.getHttpServer()).patch(`/mod/reports/${reportId}/legal-hold`).set('Authorization', auth('moderator')).send({ legalHold: true, revision: 1, ...note });
    expect(unauthorized.status).toBe(403);
    await mod.mutate(actor('admin'), reportId, 'legal-hold', { legalHold: true, revision: 1, ...note });
    expect((await mod.detail(actor('admin'), reportId)).legalHold).toBe(true);
    await expect(mod.mutate(actor('admin'), reportId, 'legal-hold', { legalHold: false, revision: 1, ...note })).rejects.toMatchObject({ status: 409 });
  });
  it('never releases an escalated hold even if stale resolution metadata is present', async () => {
    process.env.REPORT_EVIDENCE_COPY = 'on'; await reports.processEvidence();
    await db.db.collection<any>('Reports').updateOne({ _id: reportId }, { $set: { status: 'escalated', open: false, resolvedAt: new Date(0) } });
    await reports.retainEvidence();
    expect(storage.deleteOne).not.toHaveBeenCalled();
    expect((await db.db.collection<any>('ReportHolds').findOne({ _id: reportId })).active).toBe(true);
  });
  it('protects the last root from legacy admin block/update and self account deletion', async () => {
    await changeRoles(db, String(ids.root), String(ids.root2), ['user'] as any);
    expect((await request(app.getHttpServer()).put(`/users/block/${ids.root}`).set('Authorization', auth('admin')).send({ isBlocked: true })).status).toBe(403);
    expect((await request(app.getHttpServer()).patch(`/users/update/${ids.root}`).set('Authorization', auth('root')).send({ isBlocked: true })).status).toBe(403);
    await expect(photos.requestAccountDeletion(String(ids.root))).rejects.toMatchObject({ status: 403 });
    expect(await db.db.collection('Users').countDocuments({ roles: 'root', isBlocked: { $ne: true } })).toBe(1);
  });
  it('rejects both concurrent admin-on-admin demotions and concurrent last-root self changes', async () => {
    await db.db.collection('Users').updateOne({ _id: ids.manager }, { $set: { roles: ['admin'] } });
    const update = (from, to) => request(app.getHttpServer()).patch(`/users/update/${ids[to]}`).set('Authorization', auth(from)).send({ roles: ['user'] });
    const attempts = await Promise.all([update('admin', 'manager'), update('manager', 'admin')]);
    expect(attempts.map((response) => response.status)).toEqual([403, 403]);
    expect(await db.db.collection('Users').countDocuments({ _id: { $in: [ids.admin, ids.manager] }, roles: 'admin' })).toBe(2);
    await changeRoles(db, String(ids.root), String(ids.root2), ['user'] as any);
    const own = await Promise.all([update('root', 'root'), update('root', 'root')]);
    expect(own.map((response) => response.status)).toEqual([403, 403]);
    expect(await db.db.collection('Users').countDocuments({ roles: 'root' })).toBe(1);
  });
  it('serializes root removals across independent database connections', async () => {
    const second = await createConnection(process.env.TEST_MONGO_URI, { dbName: db.name, autoIndex: false }).asPromise();
    try {
      const attempts = await Promise.allSettled([
        changeRoles(db, String(ids.root), String(ids.root2), ['user'] as any),
        changeRoles(second, String(ids.root2), String(ids.root), ['user'] as any),
      ]);
      expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(await db.db.collection('Users').countDocuments({ roles: 'root', isBlocked: { $ne: true } })).toBe(1);
    } finally { await second.close(); }
  });
  it.each([true, false])('keeps an active root when a role change races self deletion (delete first=%s)', async (deleteFirst) => {
    const second = await createConnection(process.env.TEST_MONGO_URI, { dbName: db.name, autoIndex: false }).asPromise();
    try {
      const change = () => changeRoles(db, String(ids.root), String(ids.root2), ['user'] as any);
      const remove = () => new PhotosService(second, storage).requestAccountDeletion(String(ids.root));
      const attempts = await Promise.allSettled(deleteFirst ? [remove(), change()] : [change(), remove()]);
      expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(await db.db.collection('Users').countDocuments({ roles: 'root', isBlocked: { $ne: true }, deletionRequestedAt: { $exists: false } })).toBe(1);
    } finally { await second.close(); }
  });
  it.each(['anonymous', 'user', 'moderator', 'admin'])('compares disabled routes byte-for-byte with an app having no mod routes for %s', async (role) => {
    process.env.MOD_API_ENABLED = 'off';
    const module = await Test.createTestingModule({}).compile();
    const absent = module.createNestApplication();
    await absent.init();
    try {
      for (const [method, path] of [['get', '/mod/reports?before=cursor'], ['get', '/mod/review-queue'], ['get', `/mod/reports/${reportId}`],
        ['patch', `/mod/reports/${reportId}/assignment`], ['patch', `/mod/reports/${reportId}/status`], ['post', `/mod/reports/${reportId}/actions`],
        ['patch', `/mod/reports/${reportId}/legal-hold`], ['post', `/mod/reports/${reportId}/evidence/image/view`]]) {
        const call = (server) => {
          const req = request(server)[method](path);
          return (role === 'anonymous' ? req : req.set('Authorization', auth(role))).send({});
        };
        const [disabled, missing] = await Promise.all([call(app.getHttpServer()), call(absent.getHttpServer())]);
        expect(disabled.status).toBe(404); expect(disabled.status).toBe(missing.status);
        expect(disabled.text).toBe(missing.text);
      }
    } finally { await absent.close(); }
  });
  it.each([false, true])('acknowledges audit before evidence and returns no URL or bytes on failed audit (restricted=%s)', async (restricted) => {
    process.env.REPORT_EVIDENCE_COPY = 'on'; await reports.processEvidence();
    await db.db.collection<any>('Reports').updateOne({ _id: reportId }, { $set: { restricted } });
    const job = await db.db.collection('ReportEvidenceJobs').findOne({ reportId });
    const method = restricted ? 'readVerified' : 'signReportEvidence';
    storage[method].mockImplementationOnce(async () => {
      expect(await db.db.collection('StaffAuditLog').countDocuments({ reportId, action: restricted ? 'restricted_evidence_view' : 'evidence_view' })).toBe(1);
      return restricted ? Buffer.from([0xff, 0xd8, 0xff]) : 'https://private.test/evidence';
    });
    const call = () => request(app.getHttpServer()).post(`/mod/reports/${reportId}/evidence/${job.imageId}/view`).set('Authorization', auth('admin')).send({ reason: 'case_review' });
    expect((await call()).status).toBe(201);
    storage.readVerified.mockClear(); storage.signReportEvidence.mockClear();
    await db.db.command({ collMod: 'StaffAuditLog', validator: { impossible: { $exists: true } }, validationLevel: 'strict' });
    try {
      const failed = await call();
      expect(failed.status).toBe(503); expect(failed.body.message).toBe('Staff audit is unavailable');
      expect(failed.headers['content-type']).toContain('application/json');
      expect(storage.readVerified).not.toHaveBeenCalled(); expect(storage.signReportEvidence).not.toHaveBeenCalled();
      expect(failed.text).not.toContain('https://');
    } finally { await db.db.command({ collMod: 'StaffAuditLog', validator: {}, validationLevel: 'off' }); }
  });
  it('rejects the same existing JWT on suspension and accepts it after time-based expiry without changing the stored deadline', async () => {
    const token = `Bearer ${jwt.sign({ sub: String(ids.target) }, { expiresIn: 900 })}`;
    const until = new Date(Date.now() + 60000);
    await db.db.collection('Users').updateOne({ _id: ids.target }, { $set: { moderationSuspendedUntil: until } });
    expect((await request(app.getHttpServer()).get('/vault/changes').set('Authorization', token)).status).toBe(401);
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'hrtime'] });
    try {
      jest.setSystemTime(new Date(until.getTime() + 1000));
      expect((await request(app.getHttpServer()).get('/vault/changes').set('Authorization', token)).status).toBe(200);
      await expect(photos.assertActiveAccount(String(ids.target))).resolves.toBeUndefined();
      expect((await db.db.collection('Users').findOne({ _id: ids.target })).moderationSuspendedUntil).toEqual(until);
    } finally { jest.useRealTimers(); }
  });
  it.each([['user', 'moderator'], ['user', 'admin'], ['user', 'root'], ['target', 'moderator'], ['target', 'admin'], ['target', 'root']])('excludes a staff reporter or target from every case operation and assignment (%s/%s)', async (conflict, role) => {
    await db.db.collection('Users').updateOne({ _id: ids[conflict] }, { $set: { roles: [role] } });
    const conflictActor = { id: String(ids[conflict]), roles: [role] };
    await expect(mod.detail(conflictActor, reportId)).rejects.toMatchObject({ status: 404 });
    expect((await mod.queue(conflictActor)).cases).toEqual([]);
    await db.db.collection<any>('ReportReviewQueue').insertOne({ _id: String(ids.target), targetOwnerId: String(ids.target), restricted: false });
    expect(await mod.reviewQueue(conflictActor)).toEqual([]);
    for (const [kind, input] of [['transition', { status: 'in_review' }], ['action', { action: 'warn' }], ['legal-hold', { legalHold: true }], ['assign', { moderatorId: String(ids.admin) }]] as any)
      await expect(mod.mutate(conflictActor, reportId, kind, { revision: 0, ...note, ...input })).rejects.toMatchObject({ status: 404 });
    const job = await db.db.collection('ReportEvidenceJobs').findOne({ reportId });
    await expect(mod.evidence(conflictActor, reportId, job.imageId)).rejects.toMatchObject({ status: 404 });
    await expect(mod.mutate(actor('admin'), reportId, 'assign', { revision: 0, ...note, moderatorId: String(ids[conflict]) })).rejects.toMatchObject({ status: 400 });
    await expect(mod.mutate(actor('admin'), reportId, 'assign', { revision: 0, ...note, moderatorId: String(ids[conflict]).toUpperCase() })).rejects.toMatchObject({ status: 400 });
    expect(await db.db.collection('StaffAuditLog').countDocuments({})).toBe(0);
    expect(await db.db.collection('ReportTransitions').countDocuments({})).toBe(0);
    expect(storage.readVerified).not.toHaveBeenCalled(); expect(storage.signReportEvidence).not.toHaveBeenCalled();
  });
  it('makes restricted and nonexistent cases identical across routes and query-level pagination', async () => {
    await db.db.collection<any>('Reports').updateOne({ _id: reportId }, { $set: { restricted: true } });
    const missingId = randomUUID();
    const routes = [ ['get', '', {}], ['patch', '/assignment', { moderatorId: String(ids.admin), revision: 0, ...note }],
      ['patch', '/status', { status: 'in_review', revision: 0, ...note }], ['post', '/actions', { action: 'warn', revision: 0, ...note }],
      ['patch', '/legal-hold', { legalHold: true, revision: 0, ...note }], ['post', '/evidence/image/view', { reason: 'case_review' }] ];
    for (const [method, suffix, body] of routes as any) {
      const call = (id) => request(app.getHttpServer())[method](`/mod/reports/${id}${suffix}`).set('Authorization', auth('moderator')).send(body);
      const [restricted, missing] = await Promise.all([call(reportId), call(missingId)]);
      expect(restricted.status).toBe(missing.status); expect(restricted.text).toBe(missing.text);
      expect(restricted.status).toBe(suffix === '/legal-hold' ? 403 : 404);
    }
    const visible = Array.from({ length: 55 }, (_, i) => ({ _id: `visible-${String(i).padStart(3, '0')}`, reportId: `visible-${String(i).padStart(3, '0')}`, targetType: 'user', targetId: String(new Types.ObjectId()), targetOwnerId: String(ids.target), reporterId: String(ids.user), open: true, status: 'open', createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)) }));
    const hidden = Array.from({ length: 60 }, (_, i) => ({ _id: `zz-hidden-${i}`, reportId: `zz-hidden-${i}`, targetType: 'user', targetId: String(new Types.ObjectId()), targetOwnerId: String(ids.target), reporterId: String(ids.user), open: true, restricted: true, status: 'open' }));
    await db.db.collection<any>('Reports').insertMany([...visible, ...hidden]);
    const withHidden = await mod.queue(actor('moderator'));
    const secondWithHidden = await mod.queue(actor('moderator'), withHidden.nextCursor);
    expect(withHidden.cases).toHaveLength(50); expect(secondWithHidden.cases).toHaveLength(5);
    expect(Object.keys(withHidden).sort()).toEqual(['cases', 'nextCursor']); // no unfiltered totals/count field
    await db.db.collection<any>('Reports').deleteMany({ restricted: true });
    expect(await mod.queue(actor('moderator'))).toEqual(withHidden);
    expect(await mod.queue(actor('moderator'), withHidden.nextCursor)).toEqual(secondWithHidden);
    await db.db.collection<any>('ReportReviewQueue').insertMany([{ _id: 'normal', targetOwnerId: String(ids.target), updatedAt: new Date(), restricted: false },
      { _id: 'restricted', targetOwnerId: String(ids.root2), updatedAt: new Date(), restricted: true }]);
    const reviewBefore = await mod.reviewQueue(actor('moderator'));
    await db.db.collection('ReportReviewQueue').deleteMany({ restricted: true });
    expect(await mod.reviewQueue(actor('moderator'))).toEqual(reviewBefore);
  });
  it('rolls back purge scheduling if the root account write fails, leaving no unavailable root counted as active', async () => {
    const disconnect = jest.fn(); const subscription = photos.accountDeletion$.subscribe(disconnect);
    await db.db.command({ collMod: 'Users', validator: { impossible: { $exists: true } }, validationLevel: 'strict' });
    try {
      await expect(photos.requestAccountDeletion(String(ids.root))).rejects.toThrow();
      expect(await db.db.collection<any>('AccountPurges').findOne({ _id: String(ids.root) })).toBeNull();
      expect(await db.db.collection('Users').countDocuments({ roles: 'root', isBlocked: { $ne: true } })).toBe(2);
      expect(disconnect).not.toHaveBeenCalled();
    } finally { subscription.unsubscribe(); await db.db.command({ collMod: 'Users', validator: {}, validationLevel: 'off' }); }
  });
});
