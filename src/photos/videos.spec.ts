import { BadRequestException, UnprocessableEntityException } from '@nestjs/common';
import { VideosService } from './videos.service';
import { videoType } from '../s3-bucket/s3-bucket.service';
import { PostMapper } from '../posts/post.mapper';
import { parse, uploadInput } from '../vault/vault.validation';

/** Minimal in-memory collection: equality and $in/$or/$ne/$exists filters, $set updates. */
function collection(rows: any[] = []) {
  const matches = (row: any, filter: any): boolean =>
    Object.entries(filter).every(([key, expected]: [string, any]) => {
      if (key === '$or') return expected.some((option: any) => matches(row, option));
      const value = row[key];
      if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
        if ('$in' in expected) return expected.$in.includes(value);
        if ('$nin' in expected) return !expected.$nin.includes(value);
        if ('$ne' in expected) return value !== expected.$ne;
        if ('$exists' in expected) return (value !== undefined) === expected.$exists;
      }
      return value === expected;
    });
  return {
    rows,
    findOne: jest.fn(async (filter: any) => rows.find((row) => matches(row, filter)) ?? null),
    find: jest.fn((filter: any) => ({ toArray: async () => rows.filter((row) => matches(row, filter)),
      limit: () => ({ toArray: async () => rows.filter((row) => matches(row, filter)) }) })),
    countDocuments: jest.fn(async (filter: any) => rows.filter((row) => matches(row, filter)).length),
    insertOne: jest.fn(async (row: any) => { rows.push(row); }),
    deleteOne: jest.fn(async (filter: any) => { const i = rows.findIndex((row) => matches(row, filter)); if (i >= 0) rows.splice(i, 1); }),
    updateOne: jest.fn(async (filter: any, update: any) => {
      const row = rows.find((item) => matches(item, filter));
      if (row) Object.assign(row, update.$set);
      return { matchedCount: row ? 1 : 0, modifiedCount: row ? 1 : 0 };
    }),
    findOneAndUpdate: jest.fn(async (filter: any, update: any) => {
      const row = rows.find((item) => matches(item, filter));
      if (row) Object.assign(row, update.$set);
      return row ?? null;
    }),
  };
}
const owner = '507f1f77bcf86cd799439011';
const id = '7cfab11e-a5fb-43c7-987d-bda2b67d975a';
function setup(storage: any = {}) {
  const uploads = collection();
  const db: any = { db: { collection: () => uploads } };
  const photos: any = { assertActiveAccount: jest.fn(), rate: jest.fn(), enqueue: jest.fn() };
  const s3 = {
    verifyVideo: jest.fn(async () => ({ size: 1000, etag: '"etag"' })),
    startVideoModeration: jest.fn(async () => 'job-1'),
    videoModerationResult: jest.fn(async () => 'pending'),
    copyVideo: jest.fn(),
    presign: jest.fn(async () => ({ url: 'https://s3.test', fields: { key: 'k' } })),
    ...storage,
  };
  return { service: new VideosService(db, s3 as any, photos), uploads, photos, s3 };
}
const pending = (extra: any = {}) => ({ _id: id, owner, state: 'pending', contentType: 'video/mp4', declaredSize: 1000,
  tempKey: `temp/${owner}/a.mp4`, expiresAt: new Date(Date.now() + 60000), ...extra });

describe('post video uploads', () => {
  it('sniffs MP4/MOV containers and rejects other bytes', () => {
    expect(videoType(Buffer.from('\0\0\0\x18ftypisom0000', 'binary'))).toBe('video/mp4');
    expect(videoType(Buffer.from('\0\0\0\x14ftypqt  0000', 'binary'))).toBe('video/quicktime');
    expect(videoType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeUndefined();
  });

  it('rejects unsupported types and oversize videos before signing', async () => {
    const { service, s3 } = setup();
    await expect(service.issue(owner, 'video/avi', 'request-1234', 10)).rejects.toThrow(BadRequestException);
    await expect(service.issue(owner, 'video/mp4', 'request-1234', 500 * 1024 * 1024)).rejects.toThrow(BadRequestException);
    expect(s3.presign).not.toHaveBeenCalled();
  });

  it('signs uploads with the video size limit', async () => {
    const { service, s3 } = setup();
    const result: any = await service.issue(owner, 'video/mp4', 'request-1234', 1000);
    expect(result.status).toBe('pending');
    expect(s3.presign).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^temp/${owner}/[0-9a-f-]{36}\\.mp4$`)),
      'video/mp4', expect.any(Number), 50 * 1024 * 1024);
  });

  it('starts a scan on confirm and only approves after Rekognition succeeds', async () => {
    const { service, uploads, s3 } = setup();
    uploads.rows.push(pending());
    expect(await service.confirm(owner, id)).toEqual({ uploadId: id, status: 'scanning' });
    expect(uploads.rows[0]).toMatchObject({ state: 'scanning', jobId: 'job-1' });
    expect(await service.status(owner, id)).toEqual({ uploadId: id, status: 'scanning' });
    expect(s3.copyVideo).not.toHaveBeenCalled();
    s3.videoModerationResult.mockResolvedValue('approved');
    expect(await service.status(owner, id)).toEqual({ uploadId: id, status: 'approved' });
    expect(s3.copyVideo).toHaveBeenCalledWith(`temp/${owner}/a.mp4`, expect.stringMatching(new RegExp(`^videos/${owner}/[0-9a-f-]{36}\\.mp4$`)), 'video/mp4', '"etag"');
    expect(uploads.rows[0].state).toBe('approved');
  });

  it('rejects flagged videos and schedules the temp object for deletion', async () => {
    const { service, uploads, photos } = setup({ videoModerationResult: jest.fn(async () => 'rejected') });
    uploads.rows.push(pending({ state: 'scanning', jobId: 'job-1' }));
    await expect(service.status(owner, id)).rejects.toThrow(UnprocessableEntityException);
    expect(uploads.rows[0].state).toBe('rejected');
    expect(photos.enqueue).toHaveBeenCalledWith([`temp/${owner}/a.mp4`]);
  });

  it('rejects a size mismatch between the declared and stored video', async () => {
    const { service, uploads } = setup({ verifyVideo: jest.fn(async () => ({ size: 999, etag: 'e' })) });
    uploads.rows.push(pending());
    await expect(service.confirm(owner, id)).rejects.toThrow(BadRequestException);
    expect(uploads.rows[0].state).toBe('pending');
  });

  it('binds only approved videos owned by the poster, one per post', async () => {
    const { service, uploads } = setup();
    uploads.rows.push(pending({ state: 'scanning' }));
    await expect(service.bind(owner, [id], 'post:507f1f77bcf86cd799439012')).rejects.toThrow(BadRequestException);
    uploads.rows[0].state = 'approved';
    uploads.rows[0].key = `videos/${owner}/k.mp4`;
    await expect(service.bind('507f1f77bcf86cd799439099', [id], 'post:507f1f77bcf86cd799439012')).rejects.toThrow(BadRequestException);
    await expect(service.bind(owner, [id, '8cfab11e-a5fb-43c7-987d-bda2b67d975a'], 'post:507f1f77bcf86cd799439012')).rejects.toThrow(BadRequestException);
    const [video] = await service.bind(owner, [id], 'post:507f1f77bcf86cd799439012');
    expect(video).toMatchObject({ videoId: id, storageKey: `videos/${owner}/k.mp4`, contentType: 'video/mp4' });
    expect(uploads.rows[0]).toMatchObject({ state: 'attached', ref: 'post:507f1f77bcf86cd799439012' });
  });
});

describe('post video responses', () => {
  const post = { _id: 'p', user: 'author', contentVisibility: 'premium', media: [],
    videos: [{ videoId: 'v1', storageKey: 'videos/author/secret.mp4', contentType: 'video/mp4' }],
    flag: { reason: 'spam_scam', note: 'n', hidden: true, by: 'admin-id', previousStatus: 'approved' } };
  const delivery = () => ({ canRead: jest.fn(async () => true), original: jest.fn(), preview: jest.fn(() => ''),
    video: jest.fn(async () => 'https://s3.test/v.mp4?X-Amz-Signature=s') });

  it('never signs locked premium videos and never leaks storage keys', async () => {
    const media = delivery();
    const response: any = await new PostMapper().toResponse(post, { id: 'viewer' }, media);
    expect(response.videos).toEqual([{ id: 'v1', url: '', contentType: 'video/mp4' }]);
    expect(media.video).not.toHaveBeenCalled();
    expect(JSON.stringify(response)).not.toContain('secret.mp4');
    expect(response.flag).toBeUndefined();
  });

  it('signs for subscribers and shows staff-only flags to admins', async () => {
    const subscriber: any = await new PostMapper().toResponse(post, { id: 'v', premiumUntil: new Date(Date.now() + 60000) }, delivery());
    expect(subscriber.videos[0].url).toMatch(/^https:\/\/s3\.test/);
    const admin: any = await new PostMapper().toResponse(post, { id: 'a', admin: true }, delivery());
    expect(admin.flag).toEqual({ reason: 'spam_scam', note: 'n', hidden: true, at: undefined });
    expect(JSON.stringify(admin.flag)).not.toContain('admin-id');
  });
});

describe('vault video validation', () => {
  const base = { id, updatedAt: 1 };
  it('requires type, size and MD5 for videos and forbids them for photos', () => {
    expect(() => parse(uploadInput, { ...base, kind: 'video' })).toThrow(BadRequestException);
    expect(() => parse(uploadInput, { ...base, md5: 'a'.repeat(32) })).toThrow(BadRequestException);
    expect(() => parse(uploadInput, { ...base, kind: 'video', contentType: 'video/webm', size: 5, md5: 'a'.repeat(32) })).toThrow(BadRequestException);
    expect(parse(uploadInput, { ...base, kind: 'video', contentType: 'video/mp4', size: 5, md5: 'a'.repeat(32) }))
      .toMatchObject({ kind: 'video', contentType: 'video/mp4', size: 5 });
  });
});
