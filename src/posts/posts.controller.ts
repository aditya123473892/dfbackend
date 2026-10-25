import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UploadedFile,
  UseInterceptors,
  UploadedFiles,
  UseGuards,
  Query,
  Put,
} from '@nestjs/common';
import { PhotosService } from '../photos/photos.service';
import { VideosService } from '../photos/videos.service';
import { PhotoPostDto, EditPhotoPostDto } from './dto/photo-post.dto';
import {
  BadRequestException,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { PostsService } from './posts.service';
import { CreatePostDto } from './dto/create-post.dto';
import { UpdatePostDto } from './dto/update-post.dto';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthUser, Roles } from 'src/common/decorators';
import { DefaultFindParams, IAuthUser } from 'src/common/interfaces';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { S3BucketService } from 'src/s3-bucket/s3-bucket.service';
import { badRequestRes, successRes } from 'src/common/interceptors';
import { S3Folder } from 'src/common/enums/utils.enum';
import { JwtAuthGuard, RolesGuard } from 'src/common/guards';
import { FilterPostDto } from './dto/filter-post.dto';
import { EPostStatus, EPostVisibility } from 'src/common/enums/posts.enum';
import { ERole } from 'src/common/enums';
import { Media } from 'src/common/schemas/media.schema';
import { MediaDto } from 'src/common/dtos/utils.dto/media.dto';
import { CreateCommentDto } from './dto/create-comment.dto';
import { ListCommentsDto } from './dto/list-comments.dto';
import { UpdateCommentDto } from './dto/update-comment.dto';
import { PostRequestDto } from './dto/post-request.dto';
import { ApprovePostRequestDto } from './dto/approve-request.dto';

@ApiTags('Posts')
@Controller('posts')
export class PostsController {
  constructor(
    private readonly postsService: PostsService,
    private readonly photos: PhotosService,
    private readonly s3BucketService: S3BucketService,
    private readonly videos: VideosService,
  ) {}

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('/pending-request')
  @ApiOperation({ summary: 'get pending post request' })
  async getPendingRequest(@AuthUser() authUser: IAuthUser) {
    try {
      const PendingRequest = await this.postsService.getPendingRequest(
        authUser.id,
      );
      return successRes({ PendingRequest }, 'Pending Request get successfully');
    } catch (error) {
      return badRequestRes(error.message);
    }
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Patch('upload/:_id')
  async uploadMedia() {
    throw new BadRequestException('Use confirmed photoIds with PUT /posts/:id');
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Put('/approve-request/:userId')
  @ApiOperation({ summary: 'status upadat request post' })
  @ApiParam({ name: 'userId', type: String, description: 'user request ID' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Set to "accepted" to approve, "rejected" to decline',
        },
      },
    },
  })
  async approveRequest(
    @Param('userId') userId: string,
    @AuthUser() authUser: IAuthUser,
    @Body() approvePostRequestDto: ApprovePostRequestDto,
  ) {
    const approvedPost = await this.postsService.approvePostEditRequest(
      userId,
      authUser.id,
      approvePostRequestDto.status,
    );

    return approvedPost
      ? successRes({ user: approvedPost }, 'Request approved successfully')
      : badRequestRes('Failed to approve request');
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post()
  async create(
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    dto: PhotoPostDto,
    @AuthUser() actor: IAuthUser,
  ) {
    const id = createHash('sha256')
      .update(`post:${actor.id}:${dto.clientId}`)
      .digest('hex')
      .slice(0, 24);
    const existing = await this.postsService.findByIdPrivate(id, actor.id);
    if (existing) return successRes(existing);
    if (!dto.photoIds?.length && !dto.videoIds?.length)
      throw new BadRequestException('Choose at least one photo or video');
    const media = await this.photos.bind(actor.id, dto.photoIds || [], `post:${id}`);
    const videos = await this.videos.bind(actor.id, dto.videoIds || [], `post:${id}`);
    try {
      const post = await this.postsService.create({
        _id: id,
        caption: dto.caption,
        location: dto.location,
        visibility: dto.visibility || EPostVisibility.PRIVATE,
        contentVisibility: dto.contentVisibility || 'normal',
        user: actor.id,
        media,
        ...(videos.length ? { videos } : {}),
        status: EPostStatus.APPROVED,
      } as any);
      return successRes(post);
    } catch (error) {
      if (error.code === 11000)
        return successRes(
          await this.postsService.findByIdPrivate(id, actor.id),
        );
      throw error;
    }
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('/book-mark')
  @ApiOperation({ summary: 'Get Bookmarked Posts' })
  async getPostBookMark(@AuthUser() authUser: IAuthUser) {
    try {
      const bookMark = await this.postsService.getPostBookMark(authUser.id);
      return successRes({ bookMark }, 'Fetched bookmarked posts successfully');
    } catch (error) {
      return badRequestRes(error.message);
    }
  }

  // Use for feeds page
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('/public/feeds')
  async findPublicFeeds(
    @Query() params: FilterPostDto,
    @AuthUser() user: IAuthUser,
  ) {
    const options: FilterPostDto = {
      ...DefaultFindParams,
      ...params,
      visibility: EPostVisibility.PUBLIC,
      status: EPostStatus.APPROVED,
    };

    const { posts, count } = await this.postsService.findAllPublic(
      options,
      user.id,
    );

    return successRes({ posts, count });
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('/private/me')
  async findMyPosts(
    @Query() params: FilterPostDto,
    @AuthUser() user: IAuthUser,
  ) {
    const options: FilterPostDto = {
      ...DefaultFindParams,
      ...params,
      user: user.id,
    };

    const { posts, count } = await this.postsService.findAll(options);

    return successRes({ posts, count });
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get(':id')
  async findOne(@Param('id') _id: string, @AuthUser() user: IAuthUser) {
    let post;
    try {
      post = await this.postsService.findVisiblePost(_id, user.id);
    } catch (error) {
      if (error.getStatus?.() === 404) return badRequestRes('Post not found!');
      throw error;
    }

    if (!post) return badRequestRes('Post not found!');

    return successRes(post);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    dto: EditPhotoPostDto,
    @AuthUser() actor: IAuthUser,
  ) {
    const post = await this.postsService.findByIdPrivate(id, actor.id);
    if (!post) throw new NotFoundException('Post not found');
    const media = dto.photoIds
      ? await this.photos.bind(actor.id, dto.photoIds, `post:${id}`)
      : post.media;
    const videos = dto.videoIds
      ? await this.videos.bind(actor.id, dto.videoIds, `post:${id}`)
      : undefined;
    if (!media?.length && !(videos ?? (post as any).videos ?? []).length)
      throw new BadRequestException('A post needs at least one photo or video');
    const patch: any = {};
    if (dto.photoIds) patch.media = media;
    if (videos) patch.videos = videos;
    for (const field of ['caption', 'location', 'visibility', 'contentVisibility'])
      if (dto[field] !== undefined) patch[field] = dto[field];
    if (dto.photoIds || dto.videoIds) patch.status = EPostStatus.APPROVED;
    const updated = await this.postsService.updateOnePrivate(
      id,
      patch,
      actor,
      (post as any).__v ?? 0,
    );
    if (!updated) throw new NotFoundException('Post not found');
    if (dto.photoIds) {
      const keep = media.map((item) => item.filename);
      await this.photos.retire(
        `post:${id}`,
        post.media
          .filter((item) => !keep.includes(item.filename))
          .map((item) => item.filename),
      );
      await this.photos.enqueue(
        post.media
          .filter((item) => !keep.includes(item.filename))
          .map((item) => item.filename || item.url),
      );
    }
    if (videos) await this.videos.release(actor.id, `post:${id}`, dto.videoIds);
    return successRes(await this.postsService.findVisiblePost(id, actor.id));
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  async remove(@Param('id') id: string, @AuthUser() actor: IAuthUser) {
    const post = await this.postsService.findByIdPrivate(id, actor.id);
    if (!post) throw new NotFoundException('Post not found');
    // Persist a retryable deletion before removing the authorized DB row.
    await this.photos.enqueue(
      post.media.map((item) => item.filename || item.url),
    );
    const result = await this.postsService.removePrivate(
      id,
      actor.id,
      (post as any).__v ?? 0,
    );
    if (!result.deletedCount)
      throw new NotFoundException('Post changed; refresh before deleting');
    await this.photos.release(actor.id, `post:${id}`);
    await this.videos.release(actor.id, `post:${id}`);
    return successRes({ deleted: true });
  }

  // @ApiBearerAuth()
  // @UseGuards(JwtAuthGuard)
  // @Post('/book-mark/:postId')
  // @ApiOperation({ summary: 'Book-Mark Post' })
  // async postBookMark(
  //   @Param('postId') postId: string,
  //   @AuthUser() authUser: IAuthUser,
  // ) {
  //   try {
  //     const bookMark = await this.postsService.postBookMark(
  //       authUser.id,
  //       postId
  //     );
  //     return successRes({ bookMark }, 'Post bookmark successfully');
  //   } catch (error) {
  //     return badRequestRes(error.message);
  //   }
  // }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Put('/book-mark/status/:postId')
  @ApiOperation({ summary: 'Update Post Bookmark Status' })
  async updatePostBookMarkStatus(
    @Param('postId') postId: string,
    @AuthUser() authUser: IAuthUser,
  ) {
    try {
      const updatedBookMark = await this.postsService.updatePostBookMarkStatus(
        authUser.id,
        postId,
      );
      return successRes(
        { updatedBookMark },
        'Post bookmark status updated successfully',
      );
    } catch (error) {
      return badRequestRes(error.message);
    }
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post('/post-request')
  @ApiOperation({ summary: 'Send a privet post request' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        userId: {
          type: 'string',
          description: 'privet post request',
          example: '1234567890abcdef',
        },
      },
    },
  })
  async sendPostRequest(
    @Body() postRequestDto: PostRequestDto,
    @AuthUser() authUser: IAuthUser,
  ) {
    try {
      const postRequest = await this.postsService.sendPostRequest(
        authUser.id,
        postRequestDto.userId,
      );
      return successRes({ postRequest }, 'post request sent successfully');
    } catch (error) {
      return badRequestRes(error.message);
    }
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get(':postId/comments')
  @ApiOperation({ summary: 'List comments on a visible post, newest first' })
  async listComments(
    @Param('postId') postId: string,
    @Query(new ValidationPipe({ transform: true, whitelist: true }))
    params: ListCommentsDto,
    @AuthUser() user: IAuthUser,
  ) {
    return successRes(
      await this.postsService.listComments(postId, user.id, params),
    );
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post('comment')
  @ApiOperation({ summary: 'Add a comment on post' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Content of the comment' },
        post: {
          type: 'string',
          description: 'The post ID to which the comment belongs',
        },
      },
    },
  })
  async createComment(
    @Body(new ValidationPipe({ transform: true, whitelist: true }))
    createCommentDto: CreateCommentDto,
    @AuthUser() user: IAuthUser,
  ) {
    const commentData = {
      ...createCommentDto,
      user: user.id,
    };

    const comment = await this.postsService.createComment(commentData);
    if (!comment) return badRequestRes('Failed to create comment!');
    return successRes(comment);
  }

  @ApiBearerAuth()
  @Put(':postId/comment/:commentId')
  @ApiOperation({ summary: 'Update a comment on post' })
  @UseGuards(JwtAuthGuard)
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Content of the comment' },
      },
    },
  })
  async updateComment(
    @Param('postId') postId: string,
    @Param('commentId') commentId: string,
    @Body() updateCommentDto: UpdateCommentDto,
    @AuthUser() user: IAuthUser,
  ) {
    const result = await this.postsService.updateComment(
      postId,
      commentId,
      updateCommentDto,
      user.id,
    );

    if (result) {
      return successRes({ message: 'Comment updated successfully' });
    } else {
      return badRequestRes('Failed to update the comment');
    }
  }

  @ApiBearerAuth()
  @Delete(':postId/comment/:commentId')
  @ApiOperation({ summary: 'Delete comment to the post' })
  @UseGuards(JwtAuthGuard)
  async deleteComment(
    @Param('postId') postId: string,
    @Param('commentId') commentId: string,
    @AuthUser() user: IAuthUser,
  ) {
    const result = await this.postsService.deleteComment(
      postId,
      commentId,
      user.id,
    );

    if (result) {
      return successRes(result);
    } else {
      return badRequestRes('Failed to delete the comment');
    }
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post(':postId/like')
  @ApiOperation({ summary: 'Like a post' })
  @ApiResponse({ status: 200, description: 'Post liked successfully.' })
  @ApiResponse({
    status: 400,
    description: 'You have already liked this post.',
  })
  async likePost(@Param('postId') postId: string, @AuthUser() user: IAuthUser) {
    await this.postsService.likePost(postId, user.id);
    return successRes(await this.postsService.getLikeState(postId, user.id), 'Post liked successfully.');
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Delete(':postId/unlike')
  @ApiOperation({ summary: 'Unlike a post' })
  @ApiResponse({ status: 200, description: 'Post unliked successfully.' })
  @ApiResponse({
    status: 400,
    description: 'You have not liked this post yet.',
  })
  async unlikePost(
    @Param('postId') postId: string,
    @AuthUser() user: IAuthUser,
  ) {
    await this.postsService.unlikePost(postId, user.id);
    return successRes(await this.postsService.getLikeState(postId, user.id), 'Post unliked successfully.');
  }
}
