import { ForbiddenException } from '@nestjs/common';
import { PostsService } from './posts.service';
import { canReadPost } from './post-access';

describe('Bookmark visibility', () => {
  const viewer = '507f1f77bcf86cd799439011', owner = '507f1f77bcf86cd799439012';
  const id = '507f1f77bcf86cd799439013';
  function harness() {
    const post: any = { _id: id, user: owner, status: 'approved', visibility: 'public' };
    const populated: any = { ...post, user: { _id: owner }, likes: [], comments: [] };
    populated.toObject = () => ({ ...populated });
    const bookmarks: any = {
      find: jest.fn().mockReturnValue({ populate: async () => [{ postId: populated }] }),
      findOne: jest.fn().mockResolvedValue({ status: false, save: jest.fn().mockResolvedValue({ status: true }) }),
    };
    const posts: any = { findById: jest.fn(async () => post) };
    const follows: any = { exists: jest.fn().mockResolvedValue(null), findOne: jest.fn().mockResolvedValue(null) };
    const requests: any = { exists: jest.fn().mockResolvedValue(null) };
    const service = new PostsService(posts, {} as any, {} as any, follows, requests, bookmarks);
    return { post, posts, bookmarks, follows, requests, service };
  }
  it('removes an existing bookmark from results after the owner makes the post private', async () => {
    const h = harness();
    expect(await h.service.getPostBookMark(viewer)).toHaveLength(1);
    h.post.visibility = 'private';
    expect(await h.service.getPostBookMark(viewer)).toEqual([]);
    await expect(h.service.updatePostBookMarkStatus(viewer, id)).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.bookmarks.findOne).not.toHaveBeenCalled();
  });
  it('respects current owner/friend/temporary grant and rejects non-approved posts', async () => {
    const h = harness();
    h.post.visibility = 'friends';
    expect(await h.service.getPostBookMark(viewer)).toEqual([]);
    h.follows.exists.mockResolvedValue(true);
    expect(await h.service.getPostBookMark(viewer)).toHaveLength(1);
    h.post.visibility = 'private';
    h.requests.exists.mockResolvedValue(true);
    expect(await h.service.getPostBookMark(viewer)).toHaveLength(1);
    expect(h.requests.exists.mock.calls[0][0]).toMatchObject({ status: 'accepted',
      startTime: { $lte: expect.any(Date) }, endTime: { $gte: expect.any(Date) } });
    h.post.status = 'pending';
    expect(await h.service.getPostBookMark(viewer)).toEqual([]);
    expect(await h.service.getPostBookMark(owner)).toHaveLength(1);
  });
  it('propagates database outages rather than hiding them as an empty list', async () => {
    const h = harness();
    h.posts.findById.mockRejectedValue(new Error('outage'));
    await expect(h.service.getPostBookMark(viewer)).rejects.toThrow('outage');
  });
  it('denies media access without a live private grant and applies grant expiry predicates', async () => {
    const grant = jest.fn().mockResolvedValue(null);
    const db: any = { db: { collection: (name) => ({ findOne: name === 'Posts'
      ? async () => ({ user: owner, status: 'approved', visibility: 'private' }) : grant }) } };
    expect(await canReadPost(db, id, viewer)).toBe(false);
    grant.mockResolvedValue({ status: 'accepted' });
    expect(await canReadPost(db, id, viewer)).toBe(true);
    expect(grant.mock.calls[0][0]).toMatchObject({ startTime: { $lte: expect.any(Date) },
      endTime: { $gte: expect.any(Date) } });
  });
});
