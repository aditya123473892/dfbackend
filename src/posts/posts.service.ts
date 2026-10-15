import {
  BadRequestException,
  ConflictException,
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
import { Follow, FollowStatus } from 'src/common/schemas/follow.schema';
import { PostRequest, PostRequestDocument } from 'src/common/schemas/posts-request.schema';
import { PostBookMark, PostBookMarkDocument } from 'src/common/schemas/posts-bookmark.schema';
import { EPostStatus, EPostVisibility } from 'src/common/enums/posts.enum';
import { S3BucketService } from 'src/s3-bucket/s3-bucket.service';

const MAX_PAGE_SIZE = 50;
const SORTABLE_FIELDS = ['createdAt', 'updatedAt', '_id'];
const AUTHOR_FIELDS = 'displayname avatar';
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

interface PostWithCounts extends PostsDocument {
  likeCount: number;
  commentCount: number;
  likedByMe?: boolean;
}

interface PostWithFollowStatus extends PostWithCounts {
  followStatus: 'None' | 'Requested' | 'Following';
}

const idOf = (value: any): string => String(value?._id ?? value ?? '');

@Injectable()
export class PostsService {
  constructor(
    @InjectModel(Posts.name) private postsModel: Model<PostsDocument>,
    @InjectModel(Comment.name) private commentModel: Model<CommentDocument>,
    @InjectModel(Like.name) private likeModel: Model<LikeDocument>,
    @InjectModel(Follow.name) private followModel: Model<Follow>,
    @InjectModel(PostRequest.name) private PostRequestModel: Model<PostRequestDocument>,
    @InjectModel(PostBookMark.name) private PostBookMarkModel: Model<PostBookMarkDocument>,
    private readonly s3BucketService?: S3BucketService,
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
  ): Promise<PostsDocument | null> {
    const updateFields = {};
    Object.keys(payload).forEach((key) => {
      if (payload[key] !== undefined) {
        updateFields[key] = payload[key];
      }
    });

    const updatedUser = await this.postsModel
      .findOneAndUpdate(
        { _id, user: user.id },
        { $set: updateFields },
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

  /**
   * Whether the viewer may see (and therefore like or comment on) a post.
   * Authors always see their own posts. Others only see approved posts:
   * public ones, `friends` ones when they follow the author, and `private`
   * ones while an accepted post request grants them access.
   */
  async canViewPost(post: any, viewerId: string): Promise<boolean> {
    const ownerId = idOf(post.user);
    if (ownerId === viewerId) return true;
    if (post.status !== EPostStatus.APPROVED) return false;
    if (post.visibility === EPostVisibility.PUBLIC) return true;
    if (post.visibility === EPostVisibility.FRIENDS) {
      return !!(await this.followModel.exists({
        follower: viewerId,
        following: ownerId,
        status: FollowStatus.ACCEPTED,
      }));
    }
    if (post.visibility === EPostVisibility.PRIVATE) {
      const now = new Date();
      return !!(await this.PostRequestModel.exists({
        userId: ownerId,
        requestedUserId: viewerId,
        status: 'accepted',
        startTime: { $lte: now },
        endTime: { $gte: now },
      }));
    }
    return false;
  }

  /** A post the viewer may see, populated like the feed; 404 otherwise. */
  async findVisibleById(postId: string, viewerId: string) {
    const post = await this.findPostForViewer(postId, viewerId);
    await post.populate([
      { path: 'user', select: AUTHOR_FIELDS },
      { path: 'likes', select: 'user' },
      {
        path: 'comments',
        select: 'content user createdAt',
        populate: { path: 'user', select: AUTHOR_FIELDS },
      },
    ]);
    return {
      ...(await this.toClientPost(post)),
      likeCount: post.likes.length,
      commentCount: post.comments.length,
      likedByMe: this.isLikedBy(post, viewerId),
    };
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

  async remove(_id: string) {
    return await this.postsModel.deleteOne({ _id });
  }

  async removePrivate(_id: string, user: string) {
    return await this.postsModel.deleteOne({ _id, user });
  }

  /**
   * Deletes the caller's own post with its likes, comments, bookmarks and
   * stored media. Returns null when the post does not exist or belongs to
   * someone else, without touching anything.
   */
  async deleteOwnPost(postId: string, userId: string) {
    if (!Types.ObjectId.isValid(postId)) return null;
    const post = await this.postsModel.findOneAndDelete({ _id: postId, user: userId });
    if (!post) return null;
    await Promise.all([
      this.likeModel.deleteMany({ post: post._id }),
      this.commentModel.deleteMany({ post: post._id }),
      this.PostBookMarkModel.deleteMany({ postId: post._id }),
    ]);
    for (const media of post.media || []) {
      if (media.filename) {
        await this.s3BucketService?.deleteOne(media.filename, process.env.AWS_DEFAULT_S3_BUCKET);
      }
    }
    return post;
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
      })
    );

    return enhancedBookMarks.filter(Boolean);
  }

  async updatePostBookMarkStatus(userId: string, postId: string) {

    const post = await this.postsModel.findOne({ _id: postId });
    if (!post) {
      throw new Error('Post not found');
    }

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

    const isFollowing = await this.followModel.findOne({
      follower: userId,
      following: requestedUserId,
      status: "accepted"
    });

    const isFollowedBy = await this.followModel.findOne({
      follower: requestedUserId,
      following: userId,
      status: "accepted"
    });

    if (!isFollowing || !isFollowedBy) {
      throw new Error("Both users must be mutual followers with an accepted status to send a post request.");
    }

    const postRequest = new this.PostRequestModel({
      userId,
      requestedUserId
    });

    return await postRequest.save();
  }

  async getPendingRequest(userId: string) {

    const request = await this.PostRequestModel.find({
      userId: userId,
      status: "pending"
    }).populate('requestedUserId');

    if (!request || request.length === 0) {
      throw new Error("No pending requests");
    }

    return request;

  }

  async approvePostEditRequest(userId: string, approverId: string, status: string): Promise<any> {
    const startTime = new Date();
    const endTime = new Date(startTime.getTime() + 48 * 60 * 60 * 1000);

    const updatedRequest = await this.PostRequestModel.findOneAndUpdate(
        { userId: approverId, requestedUserId: userId, status: 'pending' },
        { status, startTime, endTime },
        { new: true }
    );

    return updatedRequest;
  }

  async createComment(dto: CreateCommentDto & { user: string }) {
    const content = this.validCommentContent(dto.content);
    const clientId = this.validClientId(dto.clientId);
    if (clientId) {
      const existing = await this.commentModel.findOne({ user: dto.user, clientId });
      if (existing) {
        if (idOf(existing.post) !== String(dto.post)) {
          throw new ConflictException('clientId was already used for another comment');
        }
        return this.toClientComment(existing);
      }
    }
    await this.findPostForViewer(dto.post, dto.user);

    let comment: CommentDocument;
    try {
      comment = await this.commentModel.create({ content, post: dto.post, user: dto.user, clientId });
    } catch (error) {
      if (error?.code === 11000 && clientId) {
        const existing = await this.commentModel.findOne({ user: dto.user, clientId });
        if (existing) return this.toClientComment(existing);
      }
      throw error;
    }
    // Atomic append; if the post was deleted in the meantime, undo the comment.
    const attached = await this.postsModel.updateOne(
      { _id: dto.post },
      { $addToSet: { comments: comment._id } },
    );
    if (!attached.matchedCount) {
      await this.commentModel.deleteOne({ _id: comment._id });
      throw new NotFoundException('Post not found');
    }
    return this.toClientComment(comment);
  }

  /** Newest first. `before` is the id of the last comment of the previous page. */
  async getComments(postId: string, viewerId: string, options: { limit?: number; before?: string } = {}) {
    await this.findPostForViewer(postId, viewerId);
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(Number(options.limit)) || 20));
    const filter: any = { post: new Types.ObjectId(postId) };
    if (options.before) {
      if (!Types.ObjectId.isValid(options.before)) throw new BadRequestException('Invalid cursor');
      const cursor = await this.commentModel.findOne({ _id: options.before, post: postId }).select('createdAt');
      if (!cursor) throw new BadRequestException('Invalid cursor');
      filter.$or = [
        { createdAt: { $lt: (cursor as any).createdAt } },
        { createdAt: (cursor as any).createdAt, _id: { $lt: cursor._id } },
      ];
    }
    const [rows, count] = await Promise.all([
      this.commentModel
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .limit(limit + 1)
        .populate({ path: 'user', select: AUTHOR_FIELDS }),
      this.commentModel.countDocuments({ post: postId }),
    ]);
    return {
      comments: await Promise.all(rows.slice(0, limit).map((comment) => this.toClientComment(comment))),
      hasMore: rows.length > limit,
      count,
    };
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

  /** The comment's author or the post's author may delete a comment. */
  async deleteComment(postId: string, commentId: string, userId: string) {
    if (!Types.ObjectId.isValid(postId) || !Types.ObjectId.isValid(commentId)) {
      throw new NotFoundException('Comment not found');
    }
    const post = await this.postsModel.findById(postId).select('user');
    if (!post) {
      throw new NotFoundException('Post not found');
    }
    const comment = await this.commentModel.findOne({ _id: commentId, post: postId });
    if (!comment) {
      throw new NotFoundException('Comment not found');
    }
    if (idOf(comment.user) !== userId && idOf(post.user) !== userId) {
      throw new ForbiddenException('You are not the owner of this comment');
    }
    await this.commentModel.deleteOne({ _id: comment._id });
    await this.postsModel.updateOne({ _id: postId }, { $pull: { comments: comment._id } });
    return {
      deleted: true,
      commentCount: await this.commentModel.countDocuments({ post: postId }),
    };
  }

  /**
   * Idempotent: liking twice leaves one like. The unique (post, user) index
   * decides concurrent requests; the Likes collection is the source of truth
   * and the post's `likes` array is rebuilt from it afterwards.
   */
  async likePost(postId: string, userId: string) {
    const post = await this.findPostForViewer(postId, userId);
    try {
      await this.likeModel.create({ post: post._id, user: userId });
    } catch (error) {
      if (error?.code !== 11000) throw error;
    }
    await this.syncLikes(post._id);
    return this.likeState(post._id, true);
  }

  async unlikePost(postId: string, userId: string) {
    if (!Types.ObjectId.isValid(postId)) throw new NotFoundException('Post not found');
    const post = await this.postsModel.findById(postId).select('_id');
    if (!post) {
      throw new NotFoundException('Post not found');
    }
    await this.likeModel.deleteOne({ post: post._id, user: userId });
    await this.syncLikes(post._id);
    return this.likeState(post._id, false);
  }

  async toClientPost(post: any) {
    return withSignedMedia(post, this.s3BucketService);
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

  private async findPostForViewer(postId: string, viewerId: string) {
    if (!Types.ObjectId.isValid(postId)) throw new NotFoundException('Post not found');
    const post = await this.postsModel.findById(postId);
    // A post the viewer may not see is reported as missing, not forbidden.
    if (!post || !(await this.canViewPost(post, viewerId))) {
      throw new NotFoundException('Post not found');
    }
    return post;
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

  private validClientId(value: unknown) {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string' || !CLIENT_ID_PATTERN.test(value)) {
      throw new BadRequestException('clientId must be 8-64 letters, digits, "-" or "_"');
    }
    return value;
  }

  private async toClientComment(comment: any) {
    if (comment?.populate && !comment.user?.displayname) {
      await comment.populate({ path: 'user', select: AUTHOR_FIELDS });
    }
    return comment?.toObject ? comment.toObject() : { ...comment };
  }
}

/**
 * A plain copy of the post whose media URLs are freshly signed from the stored
 * object keys. URLs signed at upload time expire, so they are never trusted.
 */
export async function withSignedMedia(post: any, s3?: S3BucketService) {
  const source = post?.toObject ? post.toObject() : { ...post };
  const ttl = Math.min(86400, Math.max(300, Number(process.env.POST_MEDIA_URL_TTL_SECONDS || 3600)));
  source.media = await Promise.all(
    (source.media || []).map(async (media: any) => {
      if (!media?.filename || !s3) return media;
      const url = await s3.getSignedURL(media.filename, process.env.AWS_DEFAULT_S3_BUCKET, ttl);
      return url ? { ...media, url } : media;
    }),
  );
  return source;
}
