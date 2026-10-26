import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, SortOrder, Types } from 'mongoose';
import { CreatePostDto } from './dto/create-post.dto';
import { UpdatePostDto } from './dto/update-post.dto';
import { Posts, PostsDocument } from 'src/common/schemas';
import { FilterPostDto } from './dto/filter-post.dto';
import { IAuthUser } from 'src/common/interfaces';
import { Comment, CommentDocument } from 'src/common/schemas/comment.schema';
import { Like, LikeDocument } from 'src/common/schemas/like.schema';
import { CreateCommentDto, MAX_COMMENT_LENGTH } from './dto/create-comment.dto';
import { UpdateCommentDto } from './dto/update-comment.dto';
import { ListCommentsDto } from './dto/list-comments.dto';
import { createHash } from 'crypto';
import { pairBlocked } from '../user-blocks/block-context';
import { visiblePostQuery } from '../user-blocks/visible-post';
import { preserveMutation } from '../reports/preservation';
import { EPostStatus, EPostVisibility } from 'src/common/enums/posts.enum';
import { Follow, FollowStatus } from 'src/common/schemas/follow.schema';
import {
  PostRequest,
  PostRequestDocument,
} from 'src/common/schemas/posts-request.schema';
import {
  PostBookMark,
  PostBookMarkDocument,
} from 'src/common/schemas/posts-bookmark.schema';

interface PostWithCounts extends PostsDocument {
  likeCount: number;
  commentCount: number;
  likedByMe?: boolean;
}

interface PostWithFollowStatus extends PostWithCounts {
  followStatus: 'None' | 'Requested' | 'Following';
}

const idOf = (value: any): string => String(value?._id ?? value ?? '');
const MAX_PAGE_SIZE = 50;
const SORTABLE_FIELDS = ['createdAt', 'updatedAt', '_id'];
const AUTHOR_FIELDS = 'displayname avatar';

@Injectable()
export class PostsService {
  constructor(
    @InjectModel(Posts.name) private postsModel: Model<PostsDocument>,
    @InjectModel(Comment.name) private commentModel: Model<CommentDocument>,
    @InjectModel(Like.name) private likeModel: Model<LikeDocument>,
    @InjectModel(Follow.name) private followModel: Model<Follow>,
    @InjectModel(PostRequest.name)
    private PostRequestModel: Model<PostRequestDocument>,
    @InjectModel(PostBookMark.name)
    private PostBookMarkModel: Model<PostBookMarkDocument>,
  ) {}

  async create(payload: CreatePostDto) {
    const post = new this.postsModel(payload);

    return await post.save();
  }

  async updateOne(
    _id: string,
    payload: UpdatePostDto,
  ): Promise<PostsDocument | null> {
    const updateFields = {};
    Object.keys(payload).forEach((key) => {
      if (payload[key] !== undefined) {
        updateFields[key] = payload[key];
      }
    });

    const updatedUser = await this.postsModel
      .findOneAndUpdate({ _id }, { $set: updateFields }, { new: true })
      .exec();

    return updatedUser;
  }

  async updateOnePrivate(
    _id: string,
    payload: UpdatePostDto,
    user: IAuthUser,
    expectedVersion?: number,
  ): Promise<PostsDocument | null> {
    const updateFields = {};
    Object.keys(payload).forEach((key) => {
      if (payload[key] !== undefined) {
        updateFields[key] = payload[key];
      }
    });

    const updatedUser = await this.postsModel
      .findOneAndUpdate(
        {
          _id,
          user: user.id,
          ...(expectedVersion === undefined ? {} : { __v: expectedVersion }),
        },
        { $set: updateFields, $inc: { __v: 1 } },
        { new: true },
      )
      .exec();

    return updatedUser;
  }

  async findAll(
    params: FilterPostDto,
    viewerId?: string,
  ): Promise<{ count: number; posts: PostWithCounts[] }> {
    const query = this.postsModel.find();

    // Apply search condition based on ownerType
    if (params.user) {
      query.where('user').equals(params.user);
    }

    if (params.visibility) {
      query.where('visibility').equals(params.visibility);
    }

    if (params.status) {
      query.where('status').equals(params.status);
    }

    this.applyPaging(query, params);

    query.populate({
      path: 'user',
      select: AUTHOR_FIELDS,
    });

    // `user` lets clients tell whether the viewer liked the post.
    query.populate({
      path: 'likes',
      select: 'user',
    });

    query.populate({
      path: 'comments',
      select: 'content user createdAt',
      populate: {
        path: 'user',
        select: AUTHOR_FIELDS,
      },
    });

    const [posts, count] = await Promise.all([
      query.exec(),
      this.postsModel.countDocuments(query.getQuery()),
    ]);

    const postsWithCounts = await Promise.all(
      posts.map(async (post) => ({
        ...(await this.toClientPost(post)),
        likeCount: post.likes.length,
        commentCount: post.comments.length,
        ...(viewerId ? { likedByMe: this.isLikedBy(post, viewerId) } : {}),
      })),
    );

    return { posts: postsWithCounts as unknown as PostWithCounts[], count };
  }

  async findAllPublic(
    params: FilterPostDto,
    authUserId: string,
  ): Promise<{ count: number; posts: PostWithFollowStatus[] }> {
    const query = this.postsModel.find();

    if (params.visibility) {
      query.where('visibility').equals(params.visibility);
    }

    if (params.status) {
      query.where('status').equals(params.status);
    }

    query.populate({
      path: 'user',
      select: AUTHOR_FIELDS,
    });

    query.populate({
      path: 'likes',
      select: 'user',
      populate: {
        path: 'user',
        select: AUTHOR_FIELDS,
      },
    });

    query.populate({
      path: 'comments',
      select: 'content user createdAt',
      populate: {
        path: 'user',
        select: AUTHOR_FIELDS,
      },
    });

    // Newest first unless the caller asks otherwise; without a sort, skip/limit
    // pages are not stable.
    this.applyPaging(query, params);

    const [posts, count] = await Promise.all([
      query.exec(),
      this.postsModel.countDocuments(query.getQuery()),
    ]);

    const postIds = posts.map((post) => post._id);
    const authorIds = [...new Set(posts.map((post) => idOf(post.user)).filter(Boolean))];
    const [userBookmarks, follows] = await Promise.all([
      this.PostBookMarkModel.find({
        userId: authUserId,
        postId: { $in: postIds },
        status: true,
      }).select('postId'),
      this.followModel
        .find({ follower: authUserId, following: { $in: authorIds } })
        .select('following status'),
    ]);

    const bookmarkedPostIds = new Set(userBookmarks.map((bm) => bm.postId.toString()));
    const followStatusByAuthor = new Map(
      follows.map((follow: any) => [
        idOf(follow.following),
        follow.status === FollowStatus.ACCEPTED ? 'Following' : 'Requested',
      ]),
    );

    const postsWithFollowStatus = await Promise.all(
      posts.map(async (post) => ({
        ...(await this.toClientPost(post)),
        likeCount: post.likes.length,
        commentCount: post.comments.length,
        likedByMe: this.isLikedBy(post, authUserId),
        followStatus: followStatusByAuthor.get(idOf(post.user)) || 'None',
        isBookmarked: bookmarkedPostIds.has(post._id.toString()),
      })),
    );

    return { posts: postsWithFollowStatus as unknown as PostWithFollowStatus[], count };
  }

  async getFollowStatusForUser(followerId: string, followingId: string): Promise<string> {
    const follow = await this.followModel.findOne({ follower: followerId, following: followingId });

    if (!follow) {
      return 'None';
    }

    if (follow.status === FollowStatus.ACCEPTED) {
      return 'Following';
    } else {
      return 'Requested';
    }
  }

  async findById(_id: string) {
    return Types.ObjectId.isValid(_id) ? await this.postsModel.findById(_id) : null;
  }

  async findByIdPrivate(_id: string, user: string) {
    if (!Types.ObjectId.isValid(_id)) return null;
    return await this.postsModel.findOne({ _id, user });
  }

  async findOne(payload: any) {
    return await this.postsModel.findOne(payload);
  }

  async findVisiblePost(id: string, viewer: string) {
    await this.commentPost(id, viewer);
    return visiblePostQuery(
      this.postsModel
        .findOne({ _id: id })
        .populate('user', 'displayname avatar'),
    );
  }

  async remove(_id: string) {
    return preserveMutation(this.postsModel.db, [`Posts:${_id}`], () => this.postsModel.deleteOne({ _id }).exec());
  }

  async removePrivate(_id: string, user: string, version?: number) {
    const result = await preserveMutation(this.postsModel.db, [`Posts:${_id}`], async () => await this.postsModel.deleteOne({
      _id,
      user,
      ...(version === undefined ? {} : { __v: version }),
    }));
    // Comments stay: they may be report evidence.
    if (result.deletedCount) {
      await Promise.all([
        this.likeModel.deleteMany({ post: _id }),
        this.PostBookMarkModel.deleteMany({ postId: _id }),
      ]);
    }
    return result;
  }

  async getPostBookMark(userId: string) {
    const bookMarks = await this.PostBookMarkModel.find({
      userId,
      status: true,
    })
      .populate({
        path: 'postId',
        populate: [
          { path: 'user', select: '_id displayname' },
          { path: 'likes', select: 'user', populate: { path: 'user', select: AUTHOR_FIELDS } },
          { path: 'comments', select: 'content user', populate: { path: 'user', select: AUTHOR_FIELDS } }
        ]
      });

    if (!bookMarks || bookMarks.length === 0) {
      return [];
    }

    const enhancedBookMarks = await Promise.all(
      bookMarks.map(async (bookmark) => {
        if (!bookmark.postId) return null;

        const post = bookmark.postId as any;
        try {
          await this.commentPost(String(post._id), userId);
        } catch (error) {
          if (error instanceof ForbiddenException || error instanceof NotFoundException) return null;
          throw error;
        }
        const postUserId = post.user._id.toString();
        const followStatus = await this.getFollowStatusForUser(userId, postUserId);

        return {
          _id: bookmark._id,
          userId: bookmark.userId,
          postId: {
            ...(await this.toClientPost(post)),
            likeCount: post.likes.length || 0,
            commentCount: post.comments.length || 0,
            followStatus,
          },
          status: bookmark.status,
        };
      }),
    );

    return enhancedBookMarks.filter(Boolean);
  }

  async updatePostBookMarkStatus(userId: string, postId: string) {
    await this.commentPost(postId, userId);

    const existingBookmark = await this.PostBookMarkModel.findOne({
      userId,
      postId,
    });

    if (!existingBookmark) {
      const newBookmark = new this.PostBookMarkModel({
        userId,
        postId,
        status: true,
      });

      const result = await newBookmark.save();

      return result;
    }

    existingBookmark.status = !existingBookmark.status;

    const updatedResult = await existingBookmark.save();

    if (!updatedResult) {
      throw new Error('Failed to update bookmark status');
    }

    return updatedResult;
  }

  async findExpiredURLPost(limit: number) {
    return await this.postsModel.find().limit(limit);
  }

  async sendPostRequest(requestedUserId: string, userId: string) {
    if (await pairBlocked(this.postsModel.db, userId, requestedUserId))
      throw new Error('User not found!');
    const isFollowing = await this.followModel.findOne({
      follower: userId,
      following: requestedUserId,
      status: 'accepted',
    });

    const isFollowedBy = await this.followModel.findOne({
      follower: requestedUserId,
      following: userId,
      status: 'accepted',
    });

    if (!isFollowing || !isFollowedBy) {
      throw new Error(
        'Both users must be mutual followers with an accepted status to send a post request.',
      );
    }

    const postRequest = new this.PostRequestModel({
      userId,
      requestedUserId,
    });

    const saved = await postRequest.save();
    if (await pairBlocked(this.postsModel.db, userId, requestedUserId)) {
      await this.PostRequestModel.updateOne(
        { _id: saved._id, status: 'pending' },
        { $set: { status: 'rejected' } },
      );
      throw new Error('User not found!');
    }
    return saved;
  }

  async getPendingRequest(userId: string) {
    const request = await this.PostRequestModel.find({
      userId: userId,
      status: 'pending',
    }).populate('requestedUserId');

    if (!request || request.length === 0) {
      throw new Error('No pending requests');
    }

    return request;
  }

  async approvePostEditRequest(
    userId: string,
    approverId: string,
    status: string,
  ): Promise<any> {
    if (await pairBlocked(this.postsModel.db, userId, approverId)) return null;
    const startTime = new Date();
    const endTime = new Date(startTime.getTime() + 48 * 60 * 60 * 1000);

    const updatedRequest = await this.PostRequestModel.findOneAndUpdate(
      { userId: approverId, requestedUserId: userId, status: 'pending' },
      { status, startTime, endTime },
      { new: true },
    );

    return updatedRequest;
  }

  private async commentPost(postId: string, userId: string) {
    if (!Types.ObjectId.isValid(postId))
      throw new BadRequestException('Invalid post ID');
    const post = await this.postsModel.findById(postId);
    if (!post) throw new NotFoundException('Post not found');
    const owner = post.user.toString();
    if (owner === userId) return post;
    if (post.status === EPostStatus.APPROVED) {
      if (post.visibility === EPostVisibility.PUBLIC) return post;
      if (
        post.visibility === EPostVisibility.FRIENDS &&
        (await this.followModel.exists({
          follower: userId,
          following: owner,
          status: FollowStatus.ACCEPTED,
        }))
      )
        return post;
      const now = new Date();
      if (
        post.visibility === EPostVisibility.PRIVATE &&
        (await this.PostRequestModel.exists({
          userId: owner,
          requestedUserId: userId,
          status: 'accepted',
          startTime: { $lte: now },
          endTime: { $gte: now },
        }))
      )
        return post;
    }
    throw new ForbiddenException('You cannot access comments on this post');
  }

  async listComments(postId: string, userId: string, params: ListCommentsDto) {
    await this.commentPost(postId, userId);
    const filter: any = { post: postId };
    if (params.before) {
      const cursor = await this.commentModel
        .findOne({ _id: params.before, post: postId })
        .lean();
      if (!cursor) throw new BadRequestException('Invalid comment cursor');
      const createdAt = (cursor as any).createdAt;
      filter.$or = [
        { createdAt: { $lt: createdAt } },
        { createdAt, _id: { $lt: cursor._id } },
      ];
    }
    const limit = params.limit ?? 20;
    const [comments, count] = await Promise.all([
      this.commentModel
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .limit(limit + 1)
        .populate('user', 'displayname firstName lastName avatar')
        .lean(),
      this.commentModel.countDocuments({ post: postId }),
    ]);
    return {
      comments: comments.slice(0, limit),
      hasMore: comments.length > limit,
      count,
    };
  }

  async createComment(
    dto: CreateCommentDto & { user: string },
  ): Promise<Comment> {
    await this.commentPost(dto.post, dto.user);
    const content = this.validCommentContent(dto.content);
    // A deterministic ID makes concurrent retries safe without a database migration.
    const id = dto.clientId
      ? new Types.ObjectId(
          createHash('sha256')
            .update(`comment:${dto.user}:${dto.post}:${dto.clientId}`)
            .digest('hex')
            .slice(0, 24),
        )
      : new Types.ObjectId();
    let comment: CommentDocument;
    try {
      comment = await this.commentModel.create({
        _id: id,
        post: dto.post,
        user: dto.user,
        content,
      });
    } catch (error) {
      if (error.code !== 11000 || !dto.clientId) throw error;
      comment = await this.commentModel.findById(id);
      if (!comment) throw error;
    }
    await this.postsModel.updateOne(
      { _id: dto.post },
      { $addToSet: { comments: comment._id } },
    );
    return comment.populate('user', 'displayname firstName lastName avatar');
  }

  async updateComment(
    postId: string,
    commentId: string,
    updateCommentDto: UpdateCommentDto,
    userId: string,
  ) {
    if (!Types.ObjectId.isValid(postId) || !Types.ObjectId.isValid(commentId)) {
      throw new NotFoundException('Comment not found');
    }
    const content = this.validCommentContent(updateCommentDto.content);
    const comment = await this.commentModel.findOneAndUpdate(
      { post: postId, _id: commentId, user: userId },
      { $set: { content } },
      { new: true },
    );
    if (!comment) throw new NotFoundException('Comment not found');
    return this.toClientComment(comment);
  }

  async deleteComment(
    postId: string,
    commentId: string,
    userId: string,
  ): Promise<{ message: string; commentCount: number }> {
    const post = await this.commentPost(postId, userId);

    if (!Types.ObjectId.isValid(commentId))
      throw new BadRequestException('Invalid comment ID');

    const commentObjectId = new Types.ObjectId(commentId);

    const commentIndex = post.comments.findIndex(
      (comment) => comment.toString() === commentObjectId.toString(),
    );

    if (commentIndex === -1) {
      throw new NotFoundException('Comment not found in the post');
    }

    const comment = await this.commentModel.findById(commentId);
    if (!comment) {
      throw new NotFoundException('Comment not found');
    }

    if (comment.user.toString() !== userId && post.user.toString() !== userId) {
      throw new ForbiddenException('You are not the owner of this comment');
    }

    await this.postsModel.updateOne(
      { _id: postId },
      { $pull: { comments: commentObjectId } },
    );

    await this.commentModel.findByIdAndDelete(commentId);

    return {
      message: 'Comment deleted successfully',
      commentCount: await this.commentModel.countDocuments({ post: postId }),
    };
  }

  /**
   * Idempotent: liking twice leaves one like. The unique (post, user) index
   * decides concurrent requests; the Likes collection is the source of truth
   * and the post's `likes` array is rebuilt from it afterwards.
   */
  async likePost(postId: string, userId: string) {
    const post = await this.commentPost(postId, userId);
    try {
      await this.likeModel.create({ post: post._id, user: userId });
    } catch (error) {
      if (error?.code !== 11000) throw error;
    }
    await this.syncLikes(post._id);
    return this.likeState(post._id, true);
  }

  async unlikePost(postId: string, userId: string) {
    const post = await this.commentPost(postId, userId);
    await this.likeModel.deleteOne({ post: post._id, user: userId });
    await this.syncLikes(post._id);
    return this.likeState(post._id, false);
  }

  /** Authoritative like state for the viewer, read from the Likes collection. */
  async getLikeState(postId: string, userId: string) {
    await this.commentPost(postId, userId);
    const [likeCount, ownLike] = await Promise.all([
      this.likeModel.countDocuments({ post: postId }),
      this.likeModel.exists({ post: postId, user: userId }),
    ]);
    return { liked: !!ownLike, likeCount };
  }

  /** Plain copy of a post; PhotoResponseInterceptor signs its media. */
  async toClientPost(post: any) {
    return post?.toObject ? post.toObject() : { ...post };
  }

  /**
   * Rebuilds the denormalized `likes` array with a compare-and-set on
   * `likesVersion`. The version is read before the like rows, so a write
   * based on rows that changed in between fails and re-reads. Interleaved
   * like/unlike requests therefore converge on the stored rows without
   * needing transactions. (A plain $addToSet/$pull pair can re-add a like
   * that a concurrent unlike just removed.)
   */
  private async syncLikes(postId: Types.ObjectId) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const post: any = await this.postsModel.findById(postId).select('likesVersion').lean();
      if (!post) return;
      const version = post.likesVersion ?? null;
      const likeIds = await this.likeModel.distinct('_id', { post: postId });
      const result = await this.postsModel.updateOne(
        { _id: postId, likesVersion: version },
        { $set: { likes: likeIds, likesVersion: (version || 0) + 1 } },
      );
      if (result.matchedCount) return;
    }
  }

  private async likeState(postId: Types.ObjectId, liked: boolean) {
    return { postId: String(postId), liked, likeCount: await this.likeModel.countDocuments({ post: postId }) };
  }

  private isLikedBy(post: any, userId: string) {
    return (post.likes || []).some((like: any) => idOf(like?.user) === userId);
  }

  private applyPaging(query: any, params: FilterPostDto) {
    const sortBy = SORTABLE_FIELDS.includes(params.sortBy) ? params.sortBy : 'createdAt';
    const order: SortOrder = String(params.order) === 'asc' || String(params.order) === '1' ? 1 : -1;
    query.sort({ [sortBy]: order, _id: order });
    const limit = Math.floor(Number(params.limit));
    query.limit(Number.isFinite(limit) && limit > 0 ? Math.min(limit, MAX_PAGE_SIZE) : 20);
    const skip = Math.floor(Number(params.skip));
    if (Number.isFinite(skip) && skip > 0) query.skip(skip);
  }

  private validCommentContent(value: unknown) {
    const content = typeof value === 'string' ? value.trim() : '';
    if (!content) throw new BadRequestException('Comment cannot be empty');
    if (content.length > MAX_COMMENT_LENGTH) {
      throw new BadRequestException(`Comments are limited to ${MAX_COMMENT_LENGTH} characters`);
    }
    return content;
  }

  private async toClientComment(comment: any) {
    if (comment?.populate && !comment.user?.displayname) {
      await comment.populate({ path: 'user', select: AUTHOR_FIELDS });
    }
    return comment?.toObject ? comment.toObject() : { ...comment };
  }
}

