import { BadRequestException, ForbiddenException, NotFoundException, ValidationPipe } from '@nestjs/common';
import { PhotosService } from './photos.service';
import { ResourceContext } from '../s3-bucket/storage-layout';
import { storageIndexes } from './storage-indexes';
import { UploadUrlDto } from './photo.dto';

const owner = '507f1f77bcf86cd799439011';
const resourceId = '507f1f77bcf86cd799439012';
const context: ResourceContext = { ownerId: owner, resourceType: 'post', resourceId, requester: owner };
function harness(row?: any) {
  const post: any = { _id: resourceId, user: owner, visibility: 'public', status: 'approved' };
  const uploads = { findOne: jest.fn(async (_filter: any) => row), updateOne: jest.fn(async (_filter: any, _update: any) => ({ matchedCount: 1 })), insertOne: jest.fn(), find: jest.fn(() => ({ toArray: async () => row ? [row] : [] })) };
  const db: any = { db: { collection: jest.fn((name: string) => name === 'PhotoUploads' ? uploads : {
    findOne: jest.fn(async () => name === 'Users' ? { _id: owner } : name === 'Posts' ? (post.deleted ? null : post) : name === 'ChatMessages' ? { sender: owner, receiver: resourceId } : null), updateOne: jest.fn(),
  }) } };
  const storage: any = { keyFromReference: (key: string) => key, getSignedURL: jest.fn(async () => 'https://signed.test/image'), copyPrivate: jest.fn(async () => ({})) };
  const service = new PhotosService(db, storage);
  jest.spyOn(service, 'rate').mockResolvedValue(undefined);
  jest.spyOn(service, 'enqueue').mockResolvedValue(undefined);
  return { service, storage, uploads, db, post };
}
describe('Checkpoint 1 resource binding', () => {
  it('rechecks post visibility and existence before signing, including previously bookmarked images', async () => {
    const key = `posts/${owner}/${resourceId}/server/original.jpg`;
    const { service, storage, post } = harness({ ownerId: owner, resourceType: 'post', resourceId,
      s3Key: key, state: 'attached' });
    const viewer = { ...context, requester: '507f1f77bcf86cd799439013' };
    await expect(service.accessUrl(key, 120, viewer)).resolves.toBe('https://signed.test/image');
    post.visibility = 'private';
    await expect(service.accessUrl(key, 120, viewer)).rejects.toBeInstanceOf(NotFoundException);
    post.deleted = true;
    await expect(service.accessUrl(key, 120, context)).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.getSignedURL).toHaveBeenCalledTimes(1);
  });
  it('reads a bound chat photo without signing a reusable URL or touching vault storage', async () => {
    const key = `chat/${owner}/direct/${resourceId}/server.jpg`;
    const chatContext: ResourceContext = { ownerId: owner, resourceType: 'chat', resourceId, requester: owner, messageId: resourceId, conversationId: 'direct' };
    const { service, storage } = harness({ ownerId: owner, resourceType: 'chat', resourceId, messageId: resourceId, conversationId: 'direct', s3Key: key, state: 'attached' });
    storage.readVerified = jest.fn().mockResolvedValue(Buffer.from('photo'));
    await expect(service.readChatPhoto(key, chatContext)).resolves.toEqual(Buffer.from('photo'));
    expect(storage.readVerified).toHaveBeenCalledWith(key, 'image/jpeg');
    expect(storage.getSignedURL).not.toHaveBeenCalled();
    await expect(service.readChatPhoto(key, { ...chatContext, resourceId: 'other' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.readChatPhoto(key, { ...chatContext, resourceType: 'vault' })).rejects.toBeInstanceOf(NotFoundException);
  });
  afterEach(() => jest.restoreAllMocks());
  it.each(['legacy', 'canonical'])('signs legacy and canonical records in %s read mode', async mode => {
    const previous = process.env.STORAGE_LAYOUT_READ;
    try {
      process.env.STORAGE_LAYOUT_READ = mode;
      for (const canonical of [false, true]) {
        const key = canonical ? `posts/${owner}/${resourceId}/server/original.jpg` : `users/${owner}/photos/legacy.jpg`;
        const row = canonical ? { ownerId: owner, resourceType: 'post', resourceId, s3Key: key, state: 'attached' } : { owner, ref: `post:${resourceId}`, key, state: 'attached' };
        const { service, storage } = harness(row);
        await expect(service.accessUrl(key, 120, context)).resolves.toBe('https://signed.test/image');
        expect(storage.getSignedURL).toHaveBeenCalledWith(key, undefined, 120, true);
        await expect(service.accessUrl(key, 120, { ...context, resourceId: 'other' })).rejects.toThrow(NotFoundException);
        await expect(service.accessUrl(key, 120, { ...context, ownerId: 'other' })).rejects.toThrow(NotFoundException);
      }
    } finally { if (previous === undefined) delete process.env.STORAGE_LAYOUT_READ; else process.env.STORAGE_LAYOUT_READ = previous; }
  });
  it('never signs approved but unbound records or a chat image in a post response', async () => {
    const key = `users/${owner}/photos/shared.jpg`;
    const { service, storage } = harness({ owner, key, state: 'approved' });
    expect(await service.displayUrl(key, context)).toBe('');
    const chat = harness({ owner, key, state: 'attached', ref: `chat:${resourceId}` });
    expect(await chat.service.displayUrl(key, context)).toBe('');
    expect(storage.getSignedURL).not.toHaveBeenCalled();
    expect(chat.storage.getSignedURL).not.toHaveBeenCalled();
    await expect(service.accessUrl(key, 120, undefined)).rejects.toThrow(NotFoundException);
  });
  it('does not reuse a URL after an account block or record deletion', async () => {
    const key = `users/${owner}/photos/legacy.jpg`;
    const { service, storage, uploads } = harness({ owner, key, state: 'attached', ref: `post:${resourceId}` });
    await service.accessUrl(key, 120, context);
    jest.spyOn(service as any, 'active').mockRejectedValue(new ForbiddenException());
    await expect(service.accessUrl(key, 120, context)).rejects.toThrow(ForbiddenException);
    uploads.findOne.mockResolvedValue(null);
    await expect(service.accessUrl(key, 120, context)).rejects.toThrow(NotFoundException);
    expect(storage.getSignedURL).toHaveBeenCalledTimes(1);
  });
  it('leaves authorized vault sync payloads and dedicated URLs unchanged', async () => {
    const { service } = harness();
    const payload = { url: 'https://signed.test/vault', photo: { id: 'sync-id', s3Key: `vault/${owner}/server.jpg`, status: 'approved' } };
    expect(await service.present(payload)).toEqual(payload);
  });
  it('copies approved temp bytes to a persisted final chat key and reuses it on retry', async () => {
    const row: any = { _id: 'upload', owner, key: `temp/${owner}/prepared.jpg`, s3Key: `temp/${owner}/prepared.jpg`, state: 'approved' };
    const { service, uploads, storage } = harness(row);
    uploads.findOne.mockImplementation(async (filter: any) => row.ref && filter.$or?.some((entry: any) => entry.ref && entry.ref !== row.ref) ? null : row);
    uploads.updateOne.mockImplementation(async (_filter: any, update: any) => { Object.assign(row, update.$set); return { matchedCount: 1 }; });
    const trusted: ResourceContext = { ownerId: owner, resourceType: 'chat', resourceId, conversationId: 'server-conversation', messageId: resourceId };
    const [media] = await service.bind(owner, ['upload'], `chat:${resourceId}`, trusted);
    expect(media.filename).toMatch(new RegExp(`^chat/server-conversation/${resourceId}/[0-9a-f-]+.jpg$`));
    expect(row).toMatchObject({ ownerId: owner, resourceType: 'chat', resourceId, conversationId: 'server-conversation', messageId: resourceId, status: 'attached' });
    await service.bind(owner, ['upload'], `chat:${resourceId}`, trusted);
    expect(storage.copyPrivate).toHaveBeenCalledTimes(1);
    await expect(service.bind(owner, ['upload'], 'post:other')).rejects.toThrow();
  });
  it('queues failed send objects with a delay and a live-reference guard', async () => {
    const row = { _id: 'upload', owner, ref: `chat:${resourceId}`, key: 'chat/final.jpg', tempKey: 'temp/source.jpg', finalKey: 'chat/final.jpg' };
    const { service } = harness(row);
    await service.failedChatSend(owner, ['upload'], `chat:${resourceId}`);
    expect(service.enqueue).toHaveBeenCalledWith(['temp/source.jpg', 'chat/final.jpg', 'chat/final.jpg'], expect.any(Date), true);
  });
  it('keeps the old upload payload contract and rejects client key injection', async () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true });
    const payload = { contentType: 'image/jpeg', requestId: 'old-client-123' };
    await expect(pipe.transform(payload, { type: 'body', metatype: UploadUrlDto })).resolves.toMatchObject(payload);
    await expect(pipe.transform({ ...payload, s3Key: 'chat/victim.jpg' }, { type: 'body', metatype: UploadUrlDto })).rejects.toThrow(BadRequestException);
  });
  it('does not create indexes at startup without an explicit flag', async () => {
    const previous = process.env.PHOTO_STORAGE_INDEXES;
    try {
      delete process.env.PHOTO_STORAGE_INDEXES;
      const { service, db } = harness(); await service.onModuleInit(); expect(db.db.collection).not.toHaveBeenCalled();
    } finally { if (previous !== undefined) process.env.PHOTO_STORAGE_INDEXES = previous; }
  });
  it('reports duplicates before writes; dry-run writes nothing; apply uses partial uniqueness', async () => {
    const calls: string[] = [];
    const createIndex = jest.fn(async () => { calls.push('index'); });
    const db: any = { db: { collection: () => ({ aggregate: () => ({ toArray: async () => [{ _id: 'posts/private-original-test-key', count: 2 }] }), createIndex }) } };
    const report = jest.fn((_message: string) => { calls.push('report'); });
    await storageIndexes(db, false, report);
    expect(createIndex).not.toHaveBeenCalled();
    expect(report.mock.calls[0][0]).not.toContain('posts/private-original-test-key');
    expect(JSON.parse(report.mock.calls[0][0])).toMatchObject({ duplicateGroups: { PhotoUploads: 1, VaultPhotos: 1 } });
    calls.length = 0;
    await storageIndexes(db, true, report);
    expect(calls[0]).toBe('report');
    expect(createIndex).toHaveBeenCalledWith({ s3Key: 1 }, expect.objectContaining({ background: true, unique: true, partialFilterExpression: { s3Key: { $type: 'string' }, storageKeyUniqueEligible: true } }));
  });
});
