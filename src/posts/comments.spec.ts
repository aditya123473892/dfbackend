import {
  BadRequestException,
  ForbiddenException,
  ValidationPipe,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { PostsService } from './posts.service';
import { PostsController } from './posts.controller';
import { CreateCommentDto } from './dto/create-comment.dto';
import { ListCommentsDto } from './dto/list-comments.dto';

describe('Post comments contract', () => {
  const owner = '507f1f77bcf86cd799439011';
  const viewer = '507f1f77bcf86cd799439012';
  const postId = '507f1f77bcf86cd799439013';
  let posts: any,
    comments: any,
    follows: any,
    requests: any,
    service: PostsService;

  beforeEach(() => {
    posts = {
      findById: jest
        .fn()
        .mockResolvedValue({
          user: owner,
          visibility: 'public',
          status: 'approved',
          comments: [],
        }),
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    comments = {
      create: jest.fn(),
      findById: jest.fn(),
      countDocuments: jest.fn().mockResolvedValue(3),
    };
    follows = { exists: jest.fn().mockResolvedValue(null) };
    requests = { exists: jest.fn().mockResolvedValue(null) };
    service = new PostsService(
      posts,
      comments,
      {} as any,
      follows,
      requests,
      {} as any,
    );
  });

  it('exposes the authenticated route requested by mobile', async () => {
    expect(
      Reflect.getMetadata('path', PostsController.prototype.listComments),
    ).toBe(':postId/comments');
    expect(
      Reflect.getMetadata('__guards__', PostsController.prototype.listComments),
    ).toHaveLength(1);
    const pipe = new ValidationPipe({ transform: true, whitelist: true });
    const dto = await pipe.transform(
      { limit: '2' },
      { type: 'query', metatype: ListCommentsDto },
    );
    expect(dto.limit).toBe(2);
    for (const input of [
      { limit: '0' },
      { limit: '101' },
      { before: 'bad-id' },
    ])
      await expect(
        pipe.transform(input, { type: 'query', metatype: ListCommentsDto }),
      ).rejects.toThrow();
  });

  it('trims content, rejects blank/oversize comments and accepts the mobile retry key', async () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true });
    const metadata = { type: 'body' as const, metatype: CreateCommentDto };
    const dto = await pipe.transform(
      {
        post: postId,
        content: ' hello ',
        clientId: 'retry-key-123',
        user: owner,
      },
      metadata,
    );
    expect(dto.content).toBe('hello');
    expect(dto.clientId).toBe('retry-key-123');
    expect(dto.user).toBeUndefined();
    for (const content of ['   ', 'x'.repeat(2001)])
      await expect(
        pipe.transform({ post: postId, content }, metadata),
      ).rejects.toThrow();
  });

  it('returns newest-first pages, authors and a total count using a stable date/ID cursor', async () => {
    const cursor = { _id: new Types.ObjectId(), createdAt: new Date() };
    comments.findOne = jest.fn().mockReturnValue({ lean: async () => cursor });
    const query: any = {};
    for (const method of ['sort', 'limit', 'populate'])
      query[method] = jest.fn().mockReturnValue(query);
    query.lean = jest
      .fn()
      .mockResolvedValue([{ _id: 'a' }, { _id: 'b' }, { _id: 'c' }]);
    comments.find = jest.fn().mockReturnValue(query);
    const result = await service.listComments(postId, viewer, {
      limit: 2,
      before: String(cursor._id),
    });
    expect(result).toEqual({
      comments: [{ _id: 'a' }, { _id: 'b' }],
      hasMore: true,
      count: 3,
    });
    expect(query.sort).toHaveBeenCalledWith({ createdAt: -1, _id: -1 });
    expect(query.limit).toHaveBeenCalledWith(3);
    expect(query.populate).toHaveBeenCalledWith(
      'user',
      'displayname firstName lastName avatar',
    );
    expect(comments.find).toHaveBeenCalledWith({
      post: postId,
      $or: [
        { createdAt: { $lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, _id: { $lt: cursor._id } },
      ],
    });
  });

  it('rejects a cursor from another post', async () => {
    comments.findOne = jest.fn().mockReturnValue({ lean: async () => null });
    await expect(
      service.listComments(postId, viewer, { limit: 20, before: owner }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(comments.findOne).toHaveBeenCalledWith({ _id: owner, post: postId });
  });

  it('rejects private and unapproved posts before reading or writing comments', async () => {
    for (const post of [
      { user: owner, visibility: 'private', status: 'approved' },
      { user: owner, visibility: 'public', status: 'pending' },
    ]) {
      posts.findById.mockResolvedValue(post);
      await expect(
        service.listComments(postId, viewer, { limit: 20 }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.createComment({ post: postId, user: viewer, content: 'hello' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }
    expect(comments.create).not.toHaveBeenCalled();
  });

  it('allows accepted followers and temporary private-post access', async () => {
    comments.find = jest
      .fn()
      .mockReturnValue({
        sort: () => ({
          limit: () => ({ populate: () => ({ lean: async () => [] }) }),
        }),
      });
    posts.findById.mockResolvedValue({
      user: owner,
      visibility: 'friends',
      status: 'approved',
    });
    follows.exists.mockResolvedValue({ _id: owner });
    await service.listComments(postId, viewer, { limit: 20 });
    expect(follows.exists).toHaveBeenCalledWith({
      follower: viewer,
      following: owner,
      status: 'accepted',
    });
    posts.findById.mockResolvedValue({
      user: owner,
      visibility: 'private',
      status: 'approved',
    });
    requests.exists.mockResolvedValue({ _id: owner });
    await service.listComments(postId, viewer, { limit: 20 });
    expect(requests.exists.mock.calls[0][0]).toMatchObject({
      userId: owner,
      requestedUserId: viewer,
      status: 'accepted',
    });
  });

  it('reuses the same comment on retry and attaches it only once with populated author', async () => {
    const comment = {
      _id: new Types.ObjectId(),
      populate: jest.fn().mockReturnThis(),
    };
    comments.create
      .mockResolvedValueOnce(comment)
      .mockRejectedValueOnce({ code: 11000 });
    comments.findById.mockResolvedValue(comment);
    const dto = {
      post: postId,
      user: viewer,
      content: ' hello ',
      clientId: 'retry-key-123',
    };
    await service.createComment(dto);
    await service.createComment(dto);
    expect(String(comments.create.mock.calls[0][0]._id)).toBe(
      String(comments.create.mock.calls[1][0]._id),
    );
    expect(comments.create.mock.calls[0][0].content).toBe('hello');
    expect(posts.updateOne).toHaveBeenLastCalledWith(
      { _id: postId },
      { $addToSet: { comments: comment._id } },
    );
    expect(comment.populate).toHaveBeenCalledWith(
      'user',
      'displayname firstName lastName avatar',
    );
  });

  it('lets the post owner remove a comment but rejects unrelated viewers', async () => {
    posts.findById.mockResolvedValue({
      user: owner,
      visibility: 'public',
      status: 'approved',
      comments: [postId],
    });
    comments.findById.mockResolvedValue({ user: '507f1f77bcf86cd799439014' });
    comments.findByIdAndDelete = jest.fn();
    await expect(
      service.deleteComment(postId, postId, viewer),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(comments.findByIdAndDelete).not.toHaveBeenCalled();
    expect(
      (await service.deleteComment(postId, postId, owner)).commentCount,
    ).toBe(3);
    expect(posts.updateOne).toHaveBeenCalledWith(
      { _id: postId },
      { $pull: { comments: new Types.ObjectId(postId) } },
    );
  });
});
