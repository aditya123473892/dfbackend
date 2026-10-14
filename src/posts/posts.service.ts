import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, SortOrder, Types } from 'mongoose';
import { CreatePostDto } from './dto/create-post.dto';
import { UpdatePostDto } from './dto/update-post.dto';
import { Posts, PostsDocument, UsersDocument } from 'src/common/schemas';
import { FilterPostDto } from './dto/filter-post.dto';
import { IAuthUser } from 'src/common/interfaces';
import { Comment, CommentDocument } from 'src/common/schemas/comment.schema';
import { Like, LikeDocument } from 'src/common/schemas/like.schema';
import { CreateCommentDto } from './dto/create-comment.dto';
import { UpdateCommentDto } from './dto/update-comment.dto';
import { Follow, FollowStatus } from 'src/common/schemas/follow.schema';
import { PostRequest, PostRequestDocument } from 'src/common/schemas/posts-request.schema';
import { PostBookMark, PostBookMarkDocument } from 'src/common/schemas/posts-bookmark.schema';

interface PostWithCounts extends PostsDocument {
  likeCount: number;
  commentCount: number;
}

interface PostWithFollowStatus extends PostWithCounts {
  followStatus: 'None' | 'Requested' | 'Following';
}

@Injectable()
export class PostsService {
  constructor(
    @InjectModel(Posts.name) private postsModel: Model<PostsDocument>,
    @InjectModel(Comment.name) private commentModel: Model<CommentDocument>,
    @InjectModel(Like.name) private likeModel: Model<LikeDocument>,
    @InjectModel(Follow.name) private followModel: Model<Follow>,
    @InjectModel(PostRequest.name) private PostRequestModel: Model<PostRequestDocument>,
    @InjectModel(PostBookMark.name) private PostBookMarkModel: Model<PostBookMarkDocument>,
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

    // Add sorting
    if (params.sortBy && params.order) {
      const sortOrder = params.order === 'desc' || params.order === -1 ? -1 : 1;
      const sortOptions: { [key: string]: SortOrder } = {
        [params.sortBy]: sortOrder,
      };
      query.sort(sortOptions);
    }

    // Add pagination
    if (params.limit) {
      query.limit(params.limit);
    }

    if (params.skip) {
      query.skip(params.skip);
    }

    query.populate({
      path: 'user',
      select: 'displayname avatar',
    });

    query.populate({
      path: 'likes',
      select: 'displayname avatar',
    });
  
    query.populate({
      path: 'comments',
      select: 'content user',
      populate: {
        path: 'user',
        select: 'displayname avatar',
      },
    });

    const [posts, count] = await Promise.all([
      query.exec(),
      this.postsModel.countDocuments(query.getQuery()),
    ]);

    const postsWithCounts = posts.map((post) => ({
      ...post.toObject(),
      likeCount: post.likes.length,
      commentCount: post.comments.length,
    })) as unknown as PostWithCounts[];

    return { posts: postsWithCounts, count };
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
      select: 'displayname avatar',
    });
  
    query.populate({
      path: 'likes',
      select: 'user',
      populate: {
        path: 'user',
        select: 'displayname avatar',
      },
    });
  
  
    query.populate({
      path: 'comments',
      select: 'content user',
      populate: {
        path: 'user',
        select: 'displayname avatar',
      },
    });
  
  
    if (params.limit) {
      query.limit(params.limit);
    }
  
    if (params.skip) {
      query.skip(params.skip);
    }
  
    const [posts, count] = await Promise.all([
      query.exec(),
      this.postsModel.countDocuments(query.getQuery()),
    ]);
    console.log("🚀 ~ PostsService ~ posts:", posts)

    const userBookmarks = await this.PostBookMarkModel.find({
      userId: authUserId,
      status: true,
    }).select('postId');
  
    const bookmarkedPostIds = new Set(userBookmarks.map((bm) => bm.postId.toString()));
  
    const postsWithFollowStatus = await Promise.all(posts.map(async (post) => {
      const postUserId = (post.user as UsersDocument)._id.toString();
      const followStatus = await this.getFollowStatusForUser(authUserId, postUserId);
  
      return {
        ...post.toObject(),
        likeCount: post.likes.length,
        commentCount: post.comments.length,
        followStatus,
        isBookmarked: bookmarkedPostIds.has(post._id.toString())
      } as unknown as PostWithFollowStatus;
    }));
  
    return { posts: postsWithFollowStatus, count };
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
    return await this.postsModel.findById(_id);
  }

  async findByIdPrivate(_id: string, user: string) {
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


  async getPostBookMark(userId: string) {
    const bookMarks = await this.PostBookMarkModel.find({
      userId,
      status: true,
    })
      .populate({
        path: 'postId',
        populate: [
          { path: 'user', select: '_id displayname' },
          { path: 'likes', select: 'user', populate: { path: 'user', select: 'displayname avatar' } },
          { path: 'comments', select: 'content user', populate: { path: 'user', select: 'displayname avatar' } }
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
            ...post.toObject(),
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


  // async postBookMark(userId: string, postId: string) {
  //   const post = await this.postsModel.findOne({ _id: postId });
  //   if (!post) {
  //     throw new Error('Post not found');
  //   }
  
  //   const existingBookmark = await this.PostBookMarkModel.findOne({
  //     userId,
  //     postId,
  //   });
  
  //   if (existingBookmark) {
  //     throw new Error('Post already bookmarked');
  //   }
  
  //   const newBookmark = new this.PostBookMarkModel({
  //     userId,
  //     postId,
  //     status: true,
  //   });
  
  //   const result = await newBookmark.save();
  
  //   if (!result) {
  //     throw new Error('Failed to create bookmark');
  //   }
  
  //   return result;
  // }
  

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
    // // Calculate the date 5 days ago
    // const fiveDaysAgo = new Date();
    // fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);

    // // Find posts that have not been updated in the last 5 days
    // return await this.postsModel
    //   .find({
    //     updatedAt: { $lt: fiveDaysAgo },
    //     cover: { $exists: true, $ne: null }, // Check if cover exists and is not null
    //   })
    //   .limit(limit);

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

    console.log(updatedRequest,'update')

    return updatedRequest;
}
  

  async createComment(createCommentDto: CreateCommentDto): Promise<Comment> {
    const newComment = new this.commentModel(createCommentDto);
    await newComment.save();

    const post = await this.postsModel.findById(createCommentDto.post);
    post.comments.push(newComment);
    await post.save();

    return newComment;
  }

  async updateComment(
    postId: string,
    commentId: string,
    updateCommentDto: UpdateCommentDto,
    userId: string,
  ): Promise<boolean> {
    const findComment = await this.commentModel.findOne({ post: postId, _id: commentId, user: userId});

    if ( updateCommentDto.content ) {
      findComment.content = updateCommentDto.content;
      await findComment.save();
    }
    return true;
  }

  async deleteComment(postId: string, commentId: string, userId: string): Promise<boolean> {
    const post = await this.postsModel.findById(postId);
    if (!post) {
      throw new NotFoundException('Post not found');
    }

    const commentObjectId = new Types.ObjectId(commentId);

    const commentIndex = post.comments.findIndex(comment => comment.toString() === commentObjectId.toString());
    
    if (commentIndex === -1) {
      throw new NotFoundException('Comment not found in the post');
    }

    const comment = await this.commentModel.findById(commentId);
    if (!comment) {
      throw new NotFoundException('Comment not found');
    }

    if (comment.user.toString() !== userId) {
      throw new ForbiddenException('You are not the owner of this comment');
    }

    post.comments.splice(commentIndex, 1);
    await post.save();

    await this.commentModel.findByIdAndDelete(commentId);

    return true;
  }

  async likePost(postId: string, userId: string): Promise<PostsDocument | null> {
    const post = await this.postsModel.findById(postId);
    if (!post) {
      throw new NotFoundException('Post not found');
    }

    const existingLike = await this.likeModel.findOne({ post: postId, user: userId });
    if (existingLike) {
      return null;
    }

    const like = new this.likeModel({ post: postId, user: userId });
    await like.save();

    post.likes.push(like.id);
    await post.save();

    return post;
  }

  async unlikePost(postId: string, userId: string): Promise<PostsDocument | null> {
    const post = await this.postsModel.findById(postId);
    if (!post) {
      throw new NotFoundException('Post not found');
    }

    const existingLike = await this.likeModel.findOne({ post: postId, user: userId });
    if (!existingLike) {
      return null;
    }

    await this.likeModel.deleteOne({ _id: existingLike._id });

    post.likes = post.likes.filter(likeId => likeId.toString() !== existingLike._id.toString());
    await post.save();

    return post;
  }
}