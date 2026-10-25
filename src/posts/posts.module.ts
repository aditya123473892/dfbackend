import { Module } from '@nestjs/common';
import { PostsService } from './posts.service';
import { PostsController } from './posts.controller';
import { MongooseModule } from '@nestjs/mongoose';
import { PostsSchema, Posts } from 'src/common/schemas';
import { S3BucketService } from 'src/s3-bucket/s3-bucket.service';
import { AdminPostsController } from './admin-posts/admin-posts.controller';
import { AdminMediaService } from './admin-posts/admin-media.service';
import { Comment, CommentSchema } from 'src/common/schemas/comment.schema';
import { Like, LikeSchema } from 'src/common/schemas/like.schema';
import { Follow, FollowSchema } from 'src/common/schemas/follow.schema';
import { PostRequest, PostRequestSchema } from 'src/common/schemas/posts-request.schema';
import { PostBookMark, PostBookMarkSchema } from 'src/common/schemas/posts-bookmark.schema';

@Module({
  imports: [
    PostRequest,
    MongooseModule.forFeature([
      {
        name: Posts.name,
        schema: PostsSchema,
      },
      {
        name: Comment.name,
        schema: CommentSchema,
      },
      {
        name: Like.name,
        schema: LikeSchema,
      },
      {
        name: Follow.name,
        schema: FollowSchema,
      },
      {
        name: PostRequest.name,
        schema: PostRequestSchema,
      },
      {
        name: PostBookMark.name,
        schema: PostBookMarkSchema,
      },
    ]),
  ],
  controllers: [PostsController, AdminPostsController],
  providers: [PostsService, S3BucketService, AdminMediaService],
  exports: [PostsService],
})
export class PostsModule {}
