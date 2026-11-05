import { Types } from 'mongoose';
import { PostsService } from './posts.service';
import { ENotificationType } from '../common/enums/notifications.enum';

describe('Likers, comment likes and saved posts', () => {
  const viewer = '507f1f77bcf86cd799439011';
  const owner = '507f1f77bcf86cd799439012';
  const blocked = '507f1f77bcf86cd799439014';
  const postId = '507f1f77bcf86cd799439013';
  const commentId = '507f1f77bcf86cd799439015';

  function harness(commentAuthor = '507f1f77bcf86cd799439016') {
    const post: any = { _id: new Types.ObjectId(postId), user: owner, status: 'approved', visibility: 'public' };
    const db: any = {
      model: () => ({ findById: () => ({ select: async () => ({ isPrivate: false }) }) }),
      db: {
        collection: () => ({
          find: () => ({ toArray: async () => [{ blockerId: new Types.ObjectId(viewer), blockedId: new Types.ObjectId(blocked) }] }),
        }),
      },
    };
    const posts: any = { findById: jest.fn(async () => post), db };
    const likeQuery: any = {};
    for (const method of ['sort', 'limit', 'populate']) likeQuery[method] = jest.fn().mockReturnValue(likeQuery);
    const likes: any = { find: jest.fn().mockReturnValue(likeQuery) };
    const stored = { likes: [] as Types.ObjectId[] };
    const comments: any = {
      findOneAndUpdate: jest.fn((_filter, update) => {
        const user = (update.$addToSet ?? update.$pull).likes as Types.ObjectId;
        const others = stored.likes.filter((id) => !id.equals(user));
        stored.likes = update.$addToSet ? [...others, user] : others;
        return { lean: async () => ({ likes: stored.likes, user: new Types.ObjectId(commentAuthor) }) };
      }),
    };
    const bookmarks: any = { findOneAndUpdate: jest.fn(async () => ({ status: true })), findOne: jest.fn() };
    const follows: any = { exists: jest.fn().mockResolvedValue(null) };
    const notifications: any = { sendNotification: jest.fn().mockResolvedValue({}) };
    const service = new PostsService(posts, comments, likes, follows, {} as any, bookmarks, notifications);
    return { service, likes, likeQuery, comments, bookmarks, notifications };
  }

  it('lists likers newest first without people blocked either way, with a cursor', async () => {
    const h = harness();
    const rows = Array.from({ length: 3 }, (_, i) => ({
      _id: new Types.ObjectId(),
      user: { _id: String(i), displayname: `Person ${i}` },
    }));
    h.likeQuery.lean = jest.fn().mockResolvedValue(rows);
    const page = await h.service.listLikers(postId, viewer, { limit: 2 });
    expect(page.users).toEqual([rows[0].user, rows[1].user]);
    expect(page.nextCursor).toBe(String(rows[1]._id));
    const filter = h.likes.find.mock.calls[0][0];
    expect(filter.user.$nin.map(String)).toEqual([blocked]);
    expect(h.likeQuery.sort).toHaveBeenCalledWith({ _id: -1 });
    expect(h.likeQuery.populate).toHaveBeenCalledWith('user', '_id displayname avatar');
  });

  it('sets a comment like idempotently and returns only the count', async () => {
    const h = harness();
    expect(await h.service.setCommentLiked(postId, commentId, viewer, true)).toEqual({ commentId, liked: true, likeCount: 1 });
    expect(await h.service.setCommentLiked(postId, commentId, viewer, true)).toEqual({ commentId, liked: true, likeCount: 1 });
    expect(await h.service.setCommentLiked(postId, commentId, viewer, false)).toEqual({ commentId, liked: false, likeCount: 0 });
    expect(await h.service.setCommentLiked(postId, commentId, viewer, false)).toEqual({ commentId, liked: false, likeCount: 0 });
  });

  it('notifies the comment author, rather than the post author, and deduplicates retries', async () => {
    const author = '507f1f77bcf86cd799439016';
    const h = harness(author);
    await h.service.setCommentLiked(postId, commentId, viewer, true);
    await h.service.setCommentLiked(postId, commentId, viewer, true);
    expect(h.notifications.sendNotification).toHaveBeenCalledTimes(2);
    for (const call of h.notifications.sendNotification.mock.calls) {
      expect(call).toEqual([author, viewer, ENotificationType.COMMENT_LIKE, 'liked your comment',
        { navigation: { postId } }, `comment-like:${commentId}:${viewer}`]);
    }
    expect(h.comments.findOneAndUpdate.mock.calls[0][0]).toEqual({ _id: commentId, post: postId });
    expect(h.comments.findOneAndUpdate.mock.calls[0][2].projection).toEqual({ likes: 1, user: 1 });
    h.notifications.sendNotification.mockClear();
    await h.service.setCommentLiked(postId, commentId, viewer, false);
    expect(h.notifications.sendNotification).not.toHaveBeenCalled();
  });

  it('does not send comment-like notifications for the author liking their own comment', async () => {
    const h = harness(viewer);
    await h.service.setCommentLiked(postId, commentId, viewer, true);
    expect(h.notifications.sendNotification).not.toHaveBeenCalled();
  });

  it('saves the requested bookmark state instead of flipping it', async () => {
    const h = harness();
    await h.service.updatePostBookMarkStatus(viewer, postId, true);
    await h.service.updatePostBookMarkStatus(viewer, postId, true);
    for (const call of h.bookmarks.findOneAndUpdate.mock.calls) {
      expect(call[0]).toEqual({ userId: viewer, postId });
      expect(call[1]).toEqual({ $set: { status: true } });
      expect(call[2]).toMatchObject({ upsert: true });
    }
    expect(h.bookmarks.findOne).not.toHaveBeenCalled();
  });
});
