import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { Harness, clientId } from './harness';
import { toUserResponse } from 'src/users/users.service';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { repair } = require('../../scripts/repair-post-interactions');

describe('Posts, likes and comments (MongoDB integration)', () => {
  const h = new Harness();
  beforeAll(() => h.start());
  afterAll(() => h.stop());
  beforeEach(() => h.reset());

  const counts = async (postId: any) => {
    const post = await h.models.Posts.findById(postId);
    return {
      likeRows: await h.models.Like.countDocuments({ post: postId }),
      likeArray: post.likes.length,
      commentRows: await h.models.Comment.countDocuments({ post: postId }),
      commentArray: post.comments.length,
    };
  };

  it('keeps a single like per user under repeated and concurrent likes', async () => {
    const [author, fan] = await h.users(2);
    const post = await h.post(author);
    await Promise.all(Array.from({ length: 10 }, () => h.posts.likePost(String(post._id), fan)));
    expect(await h.posts.likePost(String(post._id), fan)).toMatchObject({ liked: true, likeCount: 1 });
    expect(await counts(post._id)).toMatchObject({ likeRows: 1, likeArray: 1 });
  });

  it('counts concurrent likes from many users exactly', async () => {
    const [author, ...fans] = await h.users(13);
    const post = await h.post(author);
    await Promise.all(fans.map((fan) => h.posts.likePost(String(post._id), fan)));
    expect(await counts(post._id)).toMatchObject({ likeRows: 12, likeArray: 12 });
    await Promise.all(fans.slice(0, 5).map((fan) => h.posts.unlikePost(String(post._id), fan)));
    expect(await counts(post._id)).toMatchObject({ likeRows: 7, likeArray: 7 });
  });

  it('never goes negative and matches the records after rapid like/unlike toggles', async () => {
    const [author, fan] = await h.users(2);
    const post = await h.post(author);
    expect(await h.posts.unlikePost(String(post._id), fan)).toMatchObject({ liked: false, likeCount: 0 });
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        index % 2 ? h.posts.unlikePost(String(post._id), fan) : h.posts.likePost(String(post._id), fan),
      ),
    );
    const state = await counts(post._id);
    expect(state.likeRows).toBeLessThanOrEqual(1);
    expect(state.likeArray).toBe(state.likeRows);
  });

  it('only allows likes and comments on posts the user can see', async () => {
    const [author, stranger, follower] = await h.users(3);
    const pending = await h.post(author, { status: 'pending' });
    const privatePost = await h.post(author, { visibility: 'private' });
    const friendsPost = await h.post(author, { visibility: 'friends' });

    await expect(h.posts.likePost(String(pending._id), stranger)).rejects.toBeInstanceOf(NotFoundException);
    await expect(h.posts.likePost(String(privatePost._id), stranger)).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      h.posts.createComment({ post: String(privatePost._id), content: 'hi', user: stranger }),
    ).rejects.toBeInstanceOf(NotFoundException);
    // Authors can always interact with their own posts.
    await expect(h.posts.likePost(String(pending._id), author)).resolves.toMatchObject({ liked: true });

    await expect(h.posts.likePost(String(friendsPost._id), follower)).rejects.toBeInstanceOf(NotFoundException);
    await h.models.Follow.create({ follower, following: author, status: 'accepted' });
    await expect(h.posts.likePost(String(friendsPost._id), follower)).resolves.toMatchObject({ liked: true });

    const now = Date.now();
    // Stored the way PUT /posts/approve-request/:userId stores it (no enum
    // validation on that update path).
    await h.models.PostRequest.collection.insertOne({
      userId: new Types.ObjectId(author), requestedUserId: new Types.ObjectId(stranger), status: 'accepted',
      startTime: new Date(now - 1000), endTime: new Date(now + 60000),
    });
    await expect(h.posts.likePost(String(privatePost._id), stranger)).resolves.toMatchObject({ liked: true });
  });

  it('creates comments idempotently, validates them and keeps counts consistent', async () => {
    const [author, reader] = await h.users(2);
    const post = await h.post(author);
    const key = clientId();
    const [first, second] = await Promise.all([
      h.posts.createComment({ post: String(post._id), content: '  nice  ', user: reader, clientId: key }),
      h.posts.createComment({ post: String(post._id), content: '  nice  ', user: reader, clientId: key }),
    ]);
    expect(String(first._id)).toBe(String(second._id));
    expect(first).toMatchObject({ content: 'nice', user: { displayname: expect.any(String) } });

    await expect(h.posts.createComment({ post: String(post._id), content: '   ', user: reader })).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      h.posts.createComment({ post: String(post._id), content: 'x'.repeat(2001), user: reader }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await Promise.all(
      Array.from({ length: 15 }, (_, index) =>
        h.posts.createComment({ post: String(post._id), content: `c${index}`, user: reader }),
      ),
    );
    expect(await counts(post._id)).toMatchObject({ commentRows: 16, commentArray: 16 });
  });

  it('pages comments newest first', async () => {
    const [author, reader] = await h.users(2);
    const post = await h.post(author);
    for (let index = 0; index < 5; index++) {
      await h.posts.createComment({ post: String(post._id), content: `c${index}`, user: reader });
    }
    const first = await h.posts.getComments(String(post._id), reader, { limit: 3 });
    expect(first).toMatchObject({ hasMore: true, count: 5 });
    expect(first.comments.map((c: any) => c.content)).toEqual(['c4', 'c3', 'c2']);
    const second = await h.posts.getComments(String(post._id), reader, {
      limit: 3,
      before: String(first.comments[2]._id),
    });
    expect(second.hasMore).toBe(false);
    expect(second.comments.map((c: any) => c.content)).toEqual(['c1', 'c0']);
  });

  it('lets the comment author or the post author delete a comment, nobody else', async () => {
    const [author, commenter, other] = await h.users(3);
    const post = await h.post(author);
    const one = await h.posts.createComment({ post: String(post._id), content: 'one', user: commenter });
    const two = await h.posts.createComment({ post: String(post._id), content: 'two', user: commenter });

    await expect(h.posts.deleteComment(String(post._id), String(one._id), other)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      h.posts.updateComment(String(post._id), String(one._id), { content: 'edited' }, other),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(await h.posts.deleteComment(String(post._id), String(one._id), commenter)).toMatchObject({ commentCount: 1 });
    expect(await h.posts.deleteComment(String(post._id), String(two._id), author)).toMatchObject({ commentCount: 0 });
    expect(await counts(post._id)).toMatchObject({ commentRows: 0, commentArray: 0 });
    await expect(h.posts.deleteComment(String(post._id), String(two._id), author)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('deletes only the owner\'s post, with its likes, comments and media', async () => {
    const [author, other] = await h.users(2);
    const post = await h.post(author);
    await h.posts.likePost(String(post._id), other);
    await h.posts.createComment({ post: String(post._id), content: 'hi', user: other });

    expect(await h.posts.deleteOwnPost(String(post._id), other)).toBeNull();
    expect(h.s3.deleteOne).not.toHaveBeenCalled();
    expect(await h.models.Posts.countDocuments()).toBe(1);

    expect(await h.posts.deleteOwnPost(String(post._id), author)).not.toBeNull();
    expect(h.s3.deleteOne).toHaveBeenCalledWith('posts/a.jpg', undefined);
    expect(await h.models.Like.countDocuments()).toBe(0);
    expect(await h.models.Comment.countDocuments()).toBe(0);
    await expect(h.posts.likePost(String(post._id), other)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns the feed newest first with liked state, counts and freshly signed media', async () => {
    const [author, viewer] = await h.users(2);
    const older = await h.post(author, { caption: 'older', createdAt: new Date('2026-01-01') });
    await h.post(author, { caption: 'newer', createdAt: new Date('2026-02-01') });
    await h.post(author, { caption: 'hidden', status: 'pending' });
    await h.posts.likePost(String(older._id), viewer);

    const { posts, count } = await h.posts.findAllPublic(
      { visibility: 'public', status: 'approved', limit: 10, skip: 0 } as any,
      viewer,
    );
    expect(count).toBe(2);
    expect(posts.map((p: any) => p.caption)).toEqual(['newer', 'older']);
    expect(posts[1]).toMatchObject({ likeCount: 1, likedByMe: true, followStatus: 'None' });
    expect(posts[0]).toMatchObject({ likeCount: 0, likedByMe: false });
    expect(posts[0].media[0].url).toBe('https://signed.example/posts/a.jpg');
  });

  it('never exposes credentials or tokens in user responses', async () => {
    const [someone, viewer] = await h.users(2);
    const user = await h.models.Users.findById(someone).select('+password');
    const forOthers = toUserResponse(user, { id: viewer, roles: ['user'] });
    for (const field of ['password', 'passwordResetToken', 'verifyEmailToken', 'username', 'phoneNumber']) {
      expect(forOthers).not.toHaveProperty(field);
    }
    const forSelf = toUserResponse(user, { id: someone, roles: ['user'] });
    expect(forSelf).toHaveProperty('username');
    expect(forSelf).not.toHaveProperty('passwordResetToken');
  });

  it('repair script removes duplicate likes and rebuilds counts', async () => {
    const [author, fan] = await h.users(2);
    const post = await h.post(author);
    const db = h.connection.db;
    await db.collection('Likes').dropIndex('post_1_user_1');
    const rows = await db.collection('Likes').insertMany([
      { post: post._id, user: new Types.ObjectId(fan), createdAt: new Date(1) },
      { post: post._id, user: new Types.ObjectId(fan), createdAt: new Date(2) },
    ]);
    await db.collection('Posts').updateOne({ _id: post._id }, { $set: { likes: Object.values(rows.insertedIds) } });
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    await repair(db);
    expect(await counts(post._id)).toMatchObject({ likeRows: 1, likeArray: 1 });
    await expect(h.posts.likePost(String(post._id), fan)).resolves.toMatchObject({ likeCount: 1 });
  });
});
