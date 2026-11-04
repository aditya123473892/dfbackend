import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
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
import { pairBlocked, blockedIds } from '../user-blocks/block-context';
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
import { NotificationService } from 'src/notification/notification.service';
import { ENotificationType } from 'src/common/enums/notifications.enum';

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
/** Newest comments shown on each feed card. */
const FEED_COMMENT_PREVIEWS = 3;
/** Feed scans read candidate posts in batches and drop hidden authors' posts. */
const FEED_BATCH_MIN = 10;
const FEED_BATCH_MAX = 100;
/** Batches one feed page may read before returning what it found with a cursor. */
const MAX_FEED_BATCHES = 5;
/** Offset paging (legacy clients) is scanned the same way, so it is bounded. */
const MAX_FEED_OFFSET = 1000;
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
    @Optional() private readonly notifications?: NotificationService,
  ) {}

  /** Tells a post's author about activity on it. A failed notification never fails the action. */
  private notifyAuthor(post: any, actor: string, type: ENotificationType, message: string, dedupeKey: string) {
    const author = idOf(post.user);
    if (!this.notifications || author === actor) return;
    void this.notifications.sendNotification(author, actor, type, message,
      { navigation: { postId: String(post._id) } }, dedupeKey).catch(() => undefined);
  }

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
  ): Promise<{ count: number; posts: PostWithFollowStatus[]; nextCursor?: string }> {
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

    const summary = params.summary === 'true';
    if (summary) {
      // A feed card shows only the viewer's own like and the newest comments, loaded
      // for the whole page in one aggregation below.
      query.populate({ path: 'likes', match: { user: authUserId }, select: 'user' });
    } else {
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
    }
    const { posts, count, nextCursor } = await this.priorityPage(query, params, authUserId);

    const postIds = posts.map((post) => post._id);
    const authorIds = [...new Set(posts.map((post) => idOf(post.user)).filter(Boolean))];
    const [userBookmarks, follows, likeCounts, commentSummaries] = await Promise.all([
      this.PostBookMarkModel.find({
        userId: authUserId,
        postId: { $in: postIds },
        status: true,
      }).select('postId'),
      this.followModel
        .find({ follower: authUserId, following: { $in: authorIds }, status: { $in: ['pending', 'accepted'] } })
        .select('following status'),
      summary ? this.likeModel.aggregate([
        { $match: { post: { $in: postIds } } }, { $group: { _id: '$post', count: { $sum: 1 } } },
      ]) : [],
      // Count and the three newest comments of every post on the page, in one query.
      summary ? this.commentModel.aggregate([
        { $match: { post: { $in: postIds } } },
        { $group: {
          _id: '$post',
          count: { $sum: 1 },
          newest: { $topN: { n: FEED_COMMENT_PREVIEWS, sortBy: { createdAt: -1, _id: -1 },
            output: { _id: '$_id', content: '$content', user: '$user', createdAt: '$createdAt' } } },
        } },
      ]) : [],
    ]);
    const commenters = summary
      ? await this.postsModel.db.model('Users')
        .find({ _id: { $in: [...new Set(commentSummaries.flatMap((row: any) => row.newest.map((c: any) => String(c.user))))] } })
        .select(AUTHOR_FIELDS).lean()
      : [];
    const commenterById = new Map(commenters.map((user: any) => [String(user._id), user]));
    const previews = new Map(commentSummaries.map((row: any) => [String(row._id),
      row.newest.map((comment: any) => ({ ...comment, user: commenterById.get(String(comment.user)) || comment.user }))]));

    const bookmarkedPostIds = new Set(userBookmarks.map((bm) => bm.postId.toString()));
    const countsByPost = (rows: any[]) => new Map(rows.map(row => [String(row._id), row.count] as const));
    const likes = countsByPost(likeCounts), comments = countsByPost(commentSummaries);
    const followStatusByAuthor = new Map(
      follows.map((follow: any) => [
        idOf(follow.following),
        follow.status === FollowStatus.ACCEPTED ? 'Following' : 'Requested',
      ]),
    );

    const postsWithFollowStatus = await Promise.all(
      posts.map(async (post) => ({
        ...(await this.toClientPost(post)),
        ...(summary ? { comments: previews.get(String(post._id)) || [] } : {}),
        likeCount: summary ? likes.get(String(post._id)) || 0 : post.likes.length,
        commentCount: summary ? comments.get(String(post._id)) || 0 : post.comments.length,
        likedByMe: this.isLikedBy(post, authUserId),
        followStatus: followStatusByAuthor.get(idOf(post.user)) || 'None',
        isBookmarked: bookmarkedPostIds.has(post._id.toString()),
      })),
    );

    return { posts: postsWithFollowStatus as unknown as PostWithFollowStatus[], count, nextCursor };
  }

  /** Followed accounts first, then everyone else; the cursor carries group and a stable timestamp/id tie-breaker. */
  private async priorityPage(query: any, params: FilterPostDto, viewer: string) {
    const follows = await this.followModel.find({ follower: viewer, status: 'accepted' }).select('following').lean();
    const ids = follows.map(f => f.following).sort((a,b) => String(a).localeCompare(String(b)));
    const fingerprint = createHash('sha256').update(ids.map(String).join(',')).digest('hex').slice(0,16);
    let cursor: any = { group: 0, asOf: new Date().toISOString(), fingerprint };
    if (params.cursor && params.cursor !== 'start') {
      try {
        if (params.cursor.length > 1024) throw new Error();
        cursor = JSON.parse(Buffer.from(params.cursor, 'base64url').toString());
        if (![0,1].includes(cursor.group) || !Number.isFinite(Date.parse(cursor.asOf)) ||
          Date.parse(cursor.asOf) > Date.now() + 1000 || !Types.ObjectId.isValid(cursor.id) ||
          !Number.isFinite(Date.parse(cursor.date)) || Date.parse(cursor.date) > Date.parse(cursor.asOf) ||
          cursor.fingerprint !== fingerprint ||
          (cursor.count !== undefined && !(Number.isInteger(cursor.count) && cursor.count >= 0))) throw new Error();
      } catch { throw new BadRequestException('Feed changed or cursor invalid. Refresh the feed.'); }
    }
    const size = Math.max(1, Math.min(MAX_PAGE_SIZE, Number(params.limit) || 20));
    // Legacy clients page by offset; current ones by cursor.
    const offset = params.cursor ? 0 : Math.max(0, Math.min(MAX_FEED_OFFSET, Number(params.skip) || 0));
    const excluded = await blockedIds(this.postsModel.db, viewer);
    query.where({ user: { $nin: excluded.map(id => new Types.ObjectId(id)) } });
    query.and([{ $or: [{ createdAt: { $lte: new Date(cursor.asOf) } }, { createdAt: null }] }]);
    const groupQuery = (group: number) => query.clone().and([{ user: group === 0 ? { $in: ids } : { $nin: ids } }]);
    // Counted once per feed (first page) and carried in the cursor. It includes posts
    // of accounts filtered out below, so it is an upper bound.
    const count = Number.isInteger(cursor.count) ? cursor.count : await this.postsModel.countDocuments(query.getQuery());

    // Private-account public posts are discoverable only by accepted followers or their
    // owner. Rather than excluding every such account up front, each scanned batch
    // looks up only its own authors.
    const hiddenAuthors = new Map<string, boolean>();
    const lookUpAuthors = async (rows: any[]) => {
      const unknown = [...new Set(rows.map(row => idOf(row.user)))].filter(id => !hiddenAuthors.has(id) && Types.ObjectId.isValid(id));
      if (!unknown.length) return;
      const hidden = await this.postsModel.db.model('Users').find({
        _id: { $in: unknown.map(id => new Types.ObjectId(id)) },
        $or: [
          { isPrivate: true, _id: { $nin: [...ids, new Types.ObjectId(viewer)] } },
          { isBlocked: true }, { deletionRequestedAt: { $ne: null } },
          { moderationSuspendedUntil: { $gt: new Date() } },
        ],
      }).select('_id').lean();
      const set = new Set(hidden.map(user => String(user._id)));
      for (const id of unknown) hiddenAuthors.set(id, set.has(id));
    };
    // Rows strictly after (older than) a position in feed order; null dates sort last.
    const after = (date: Date | null, id: Types.ObjectId) => date
      ? { $or: [{ createdAt: { $lt: date } }, { createdAt: date, _id: { $lt: id } }, { createdAt: null }] }
      : { createdAt: null, _id: { $lt: id } };

    const target = offset + size + 1;
    let rows: any[] = [], groups: number[] = [];
    let group: number = cursor.group;
    let position = cursor.id ? after(cursor.legacy ? null : new Date(cursor.date), new Types.ObjectId(cursor.id)) : undefined;
    let scanned: { row: any; group: number } | undefined;
    for (let batch = 0; group <= 1 && rows.length < target && batch < MAX_FEED_BATCHES + Math.ceil(offset / size); batch++) {
      const part = groupQuery(group);
      if (position) part.and([position]);
      const limit = Math.min(FEED_BATCH_MAX, Math.max(FEED_BATCH_MIN, (target - rows.length) * 2));
      const found = await part.sort({ createdAt: -1, _id: -1 }).limit(limit).exec();
      await lookUpAuthors(found);
      for (const row of found) {
        scanned = { row, group };
        if (hiddenAuthors.get(idOf(row.user))) continue;
        rows.push(row); groups.push(group);
        if (rows.length >= target) break;
      }
      if (rows.length >= target) break;
      if (found.length < limit) { group++; position = undefined; }
      else position = after(scanned!.row.createdAt || null, scanned!.row._id);
    }
    rows = rows.slice(offset); groups = groups.slice(offset);
    // A full page continues after its last row; a scan stopped early, after the last row it read.
    const mark = rows.length > size ? { row: rows[size - 1], group: groups[size - 1] }
      : group <= 1 ? scanned : undefined;
    rows = rows.slice(0, size);
    const nextCursor = mark ? Buffer.from(JSON.stringify({ group: mark.group,
      asOf: cursor.asOf, fingerprint, count, legacy: !mark.row.createdAt,
      date: new Date(mark.row.createdAt || mark.row._id.getTimestamp()).toISOString(), id: String(mark.row._id) })).toString('base64url') : undefined;
    return { posts: rows, count, nextCursor };
  }

  async getFollowStatusForUser(followerId: string, followingId: string): Promise<string> {
    const follow = await this.followModel.findOne({ follower: followerId, following: followingId });

    if (!follow || follow.status === FollowStatus.REJECTED) {
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
    const account = await this.postsModel.db.model('Users').findById(owner).select('isPrivate');
    if (account?.isPrivate === true && !await this.followModel.exists({
      follower: userId, following: owner, status: FollowStatus.ACCEPTED,
    })) throw new ForbiddenException('Post unavailable');
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
    const post = await this.commentPost(dto.post, dto.user);
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
    this.notifyAuthor(post, dto.user, ENotificationType.POST_COMMENT,
      'commented on your post', 'comment:' + String(comment._id));
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
      // One notification per liker and post, so unliking and liking again does not repeat it.
      this.notifyAuthor(post, userId, ENotificationType.POST_LIKE,
        'liked your post', 'like:' + String(post._id) + ':' + userId);
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

