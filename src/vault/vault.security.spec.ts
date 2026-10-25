import { VaultService } from './vault.service';
import { PhotosService } from '../photos/photos.service';
import { parse, uploadInput } from './vault.validation';
import { BadRequestException, NotFoundException } from '@nestjs/common';

const owner = '0123456789abcdef01234567';
const id = '12345678-1234-4234-8234-123456789abc';
describe('Vault isolation and durable deletion', () => {
  it.each(['legacy', 'canonical'])('signs stored legacy and canonical vault keys in %s mode', async mode => {
    const previous = process.env.STORAGE_LAYOUT_READ;
    try {
      process.env.STORAGE_LAYOUT_READ = mode;
      for (const canonical of [false, true]) {
        const key = canonical ? `vault/${owner}/${id}.jpg` : `users/${owner}/vault/${id}/${id}.jpg`;
        const row = { owner, id, key, state: 'approved', ...(canonical ? { ownerId: owner, resourceType: 'vault', resourceId: id, serverPhotoId: id, s3Key: key } : {}) };
        const db: any = { db: { collection: (name: string) => ({ findOne: async () => name === 'VaultPhotos' ? row : null }) } };
        const storage: any = { getSignedURL: jest.fn(async () => 'https://signed.test/vault') };
        const service = new VaultService(db, storage, { assertActiveAccount: jest.fn(), rate: jest.fn() } as any);
        await expect(service.download(owner, id)).resolves.toMatchObject({ url: 'https://signed.test/vault' });
        expect(storage.getSignedURL).toHaveBeenCalledWith(key, undefined, 120, true);
      }
    } finally { if (previous === undefined) delete process.env.STORAGE_LAYOUT_READ; else process.env.STORAGE_LAYOUT_READ = previous; }
  });
  it('denies canonical vault records whose resource binding does not match the requested photo', async () => {
    const row = { owner, id, key: `vault/${owner}/${id}.jpg`, ownerId: owner, resourceType: 'vault', resourceId: 'different-photo', serverPhotoId: id };
    const db: any = { db: { collection: (name: string) => ({ findOne: async () => name === 'VaultPhotos' ? row : null }) } };
    const storage: any = { getSignedURL: jest.fn() };
    const service = new VaultService(db, storage, { assertActiveAccount: jest.fn(), rate: jest.fn() } as any);
    await expect(service.download(owner, id)).rejects.toThrow(NotFoundException);
    expect(storage.getSignedURL).not.toHaveBeenCalled();
  });
  it('the scheduled cleanup worker defers an unused-object job while a vault photo references it', async () => {
    const key = `users/${owner}/vault/${id}.jpg`;
    const job = { _id: 'job', key, dueAt: new Date(0), attempts: 0, onlyIfUnused: true };
    const updateOne = jest.fn();
    const emptyCursor = { limit() { return this; }, toArray: async () => [] };
    const db = { db: { collection: (name: string) => ({
      find: () => name === 'PhotoDeletionJobs' ? { limit() { return this; }, toArray: async () => [job] } : emptyCursor,
      findOne: async () => name === 'VaultPhotos' ? { key, state: 'approved' } : null,
      updateOne, deleteOne: jest.fn(), deleteMany: jest.fn(),
    }) } };
    const storage = { deleteOne: jest.fn() };
    await new PhotosService(db as any, storage as any).cleanup();
    expect(storage.deleteOne).not.toHaveBeenCalled();
    expect(updateOne).toHaveBeenCalledWith({ _id: 'job' }, { $set: { dueAt: expect.any(Date) } });
  });
  it('protects live vault photos from the existing unused-photo cleanup jobs', async () => {
    const key = `users/${owner}/vault/${id}.jpg`;
    const calls: any[] = [];
    const db = { db: { collection: (name: string) => ({ findOne: async (filter: any) => {
      calls.push([name, filter]);
      return name === 'VaultPhotos' && filter.key === key ? { key, state: 'approved' } : null;
    } }) } };
    const storage = { deleteOne: jest.fn() };
    const service = new PhotosService(db as any, storage as any);
    expect(await (service as any).inUse(key)).toBe(true);
    expect(calls[0][0]).toBe('VaultPhotos');
    expect(storage.deleteOne).not.toHaveBeenCalled();
  });
  it('never resolves vault keys through profile/discovery/chat presentation or access URL', async () => {
    const storage = { keyFromReference: (key: string) => key, getSignedURL: jest.fn() };
    const service = new PhotosService({} as any, storage as any);
    const key = `users/${owner}/vault/${id}.jpg`;
    const result = await service.present({ avatar: key, media: [{ filename: key, mimetype: 'image/jpeg' }] });
    expect(result.avatar).toBe(''); expect(result.media).toEqual([]);
    await expect(service.accessUrl(key, 120, undefined)).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.getSignedURL).not.toHaveBeenCalled();
  });
  it('removes S3 versions and the live DB row, retains a tombstone, and retries failures', async () => {
    let row: any = { _id: `${owner}:${id}`, owner, id, key: `users/${owner}/vault/${id}.jpg`, tempKey: `temp/${owner}/${id}.jpg`, state: 'approved', expiresAt: new Date(0) };
    let tombstone: any;
    const db = { db: { collection: (name: string) => name === 'VaultTombstones' ? {
      updateOne: async (_filter: any, update: any) => { tombstone ??= update.$setOnInsert; },
    } : {
      findOne: async () => row,
      updateOne: async (_filter: any, update: any) => { Object.assign(row, update.$set); },
      find: () => ({ limit: () => ({ toArray: async () => row?.state === 'deleting' ? [row] : [] }) }),
      deleteOne: jest.fn(async () => { row = null; }),
    } } };
    const storage = { deleteOne: jest.fn().mockRejectedValueOnce(new Error('S3 unavailable')).mockResolvedValue(undefined) };
    const photos = { assertActiveAccount: jest.fn(), rate: jest.fn() };
    const service = new VaultService(db as any, storage as any, photos as any);
    await service.remove(owner, id, 1);
    expect(row.state).toBe('deleting'); expect(tombstone.deletedAt).toBeGreaterThan(0);
    await service.cleanup(); expect(row).toBeNull();
    expect(storage.deleteOne).toHaveBeenCalledWith(`users/${owner}/vault/${id}.jpg`);
    expect(storage.deleteOne).toHaveBeenCalledWith(`temp/${owner}/${id}.jpg`);
  });
  it('scopes every download lookup to the verified owner and checks the exact vault prefix', async () => {
    const findOne = jest.fn().mockResolvedValue(null);
    const db = { db: { collection: () => ({ findOne }) } };
    const storage = { getSignedURL: jest.fn() };
    const service = new VaultService(db as any, storage as any, { assertActiveAccount: jest.fn(), rate: jest.fn() } as any);
    await expect(service.download(owner, id)).rejects.toBeInstanceOf(NotFoundException);
    expect(findOne).toHaveBeenLastCalledWith({ owner, id, state: 'approved' });
    expect(storage.getSignedURL).not.toHaveBeenCalled();
  });
  it('rejects client ownership/key injection and malformed UUIDs', () => {
    expect(() => parse(uploadInput, { id, updatedAt: 1, userId: 'other' })).toThrow(BadRequestException);
    expect(() => parse(uploadInput, { id: '../photo', updatedAt: 1 })).toThrow(BadRequestException);
    expect(parse(uploadInput, { id, updatedAt: 1 })).toEqual({ id, updatedAt: 1, hidden: true, order: 0 });
  });
});
