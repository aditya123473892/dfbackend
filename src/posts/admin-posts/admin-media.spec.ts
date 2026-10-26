import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { AdminMediaService, flagInput, mediaListInput, parseAdmin, visibilityInput } from './admin-media.service';

const postId = '507f1f77bcf86cd799439012';
function setup(post: any) {
  const audit: any[] = [];
  const posts = {
    findOne: jest.fn(async () => post),
    updateOne: jest.fn(async (filter: any, update: any) => {
      if (filter.status !== undefined && filter.status !== post.status) return { matchedCount: 0 };
      Object.assign(post, update.$set);
      for (const key of Object.keys(update.$unset || {})) delete post[key];
      return { matchedCount: 1 };
    }),
  };
  const db: any = { db: { collection: (name: string) => (name === 'AdminAuditLog' ? { insertOne: async (row: any) => audit.push(row) } : posts) } };
  return { service: new AdminMediaService(db), posts, audit };
}

describe('admin media review', () => {
  it('validates filters, visibility and flag input strictly', () => {
    expect(parseAdmin(mediaListInput, {})).toEqual({ filter: 'all' });
    expect(() => parseAdmin(mediaListInput, { filter: 'vault' })).toThrow(BadRequestException);
    expect(() => parseAdmin(visibilityInput, { contentVisibility: 'admin' })).toThrow(BadRequestException);
    expect(() => parseAdmin(flagInput, { flagged: true, reason: 'unknown' })).toThrow(BadRequestException);
    expect(() => parseAdmin(flagInput, { flagged: false, reason: 'spam_scam' })).toThrow(BadRequestException);
    expect(parseAdmin(flagInput, { flagged: true, reason: 'spam_scam' })).toEqual({ flagged: true, reason: 'spam_scam', hide: false });
  });

  it('hiding flag archives the post and unflagging restores its previous status', async () => {
    const post: any = { _id: new Types.ObjectId(postId), status: 'approved' };
    const { service, audit } = setup(post);
    await service.setFlag('admin', postId, { flagged: true, reason: 'nudity_sexual', note: 'x', hide: true });
    expect(post.status).toBe('archived');
    expect(post.flag).toMatchObject({ reason: 'nudity_sexual', hidden: true, previousStatus: 'approved', by: 'admin' });
    // Re-flagging keeps the original status to restore.
    await service.setFlag('admin', postId, { flagged: true, reason: 'spam_scam', hide: false });
    expect(post.status).toBe('approved');
    expect(post.flag.previousStatus).toBe('approved');
    await service.setFlag('admin', postId, { flagged: true, reason: 'spam_scam', hide: true });
    await service.setFlag('admin', postId, { flagged: false });
    expect(post.status).toBe('approved');
    expect(post.flag).toBeUndefined();
    expect(audit.map((row) => row.action)).toEqual(['flag:nudity_sexual:hidden', 'flag:spam_scam', 'flag:spam_scam:hidden', 'unflag']);
  });

  it('changes content visibility and audits only real changes', async () => {
    const post: any = { _id: new Types.ObjectId(postId), status: 'approved' };
    const { service, audit } = setup(post);
    expect(await service.setVisibility('admin', postId, 'premium')).toEqual({ id: postId, contentVisibility: 'premium' });
    expect(post.contentVisibility).toBe('premium');
    await service.setVisibility('admin', postId, 'premium');
    expect(audit).toHaveLength(1);
  });

  it('refuses unknown or deleted posts', async () => {
    const { service } = setup(null);
    await expect(service.setVisibility('admin', 'not-an-id', 'premium')).rejects.toThrow(NotFoundException);
    await expect(service.setFlag('admin', postId, { flagged: false })).rejects.toThrow(NotFoundException);
  });
});
