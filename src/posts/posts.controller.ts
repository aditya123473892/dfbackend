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
import { PostsService } from './posts.service';
import { CreatePostDto } from './dto/create-post.dto';
import { UpdatePostDto } from './dto/update-post.dto';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
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
import { UpdateCommentDto } from './dto/update-comment.dto';
import { PostRequestDto } from './dto/post-request.dto';
import { ApprovePostRequestDto } from './dto/approve-request.dto';

@ApiTags('Posts')
@Controller('posts')
export class PostsController {
  constructor(
    private readonly postsService: PostsService,
    private readonly s3BucketService: S3BucketService,
  ) {}

  // @Post('upload')
  // @ApiConsumes('multipart/form-data')
  // @ApiBody({
  //   schema: {
  //     type: 'object',
  //     properties: {
  //       file: {
  //         type: 'string',
  //         format: 'binary',
  //       },
  //     },
  //   },
  // })
  // @UseInterceptors(FileInterceptor('file'))
  // async uploadDocument(@UploadedFile() file, @Body() payload: CreatePostDto) {
  //   console.log(file);

  //   //Upload file to S3 bucket
  //   const uploadedFile = await this.s3BucketService.uploadFile(
  //     file,
  //     S3Folder.POSTS,
  //   );

  //   if (!uploadedFile) {
  //     return badRequestRes('Failed to upload file!');
  //   }

  //   // Generate secure url for document and save it to table
  //   const url = await this.s3BucketService.getSignedURL(
  //     uploadedFile.Key,
  //     process.env.AWS_DEFAULT_S3_BUCKET,
  //   );

  //   // dto.filename = file.originalname;
  //   // dto.mimeType = file.mimetype;
  //   // dto.key = uploadedFile.Key;
  //   // dto.doc = url;
  //   return successRes({ uploadedFile, url });
  // }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('/pending-request')
  @ApiOperation({ summary: 'get pending post request' })
  async getPendingRequest(
    @AuthUser() authUser: IAuthUser,
  ) {
    try {
      console.log("authUser", authUser)
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
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        media: {
          type: 'array',
          items: {
            type: 'string',
            format: 'binary',
          },
        },
      },
    },
  })
  @UseInterceptors(FilesInterceptor('media'))
  async uploadMedia(
    @Param('_id') _id: string,
    @UploadedFiles() media,
    @AuthUser() user: IAuthUser,
  ) {
    console.log(media);

    const post = await this.postsService.findByIdPrivate(_id, user.id);

    if (!post) return badRequestRes('Post not found!');

    const uploadedFiles = [];

    let tempMedia = [];

    // Upload files to S3 bucket
    for (const file of media) {
      const uploadedFile: any = await this.s3BucketService.uploadFile(
        file,
        S3Folder.POSTS,
      );

      if (!uploadedFile) {
        return badRequestRes('Failed to upload files!');
      }

      // Generate secure URL for each file and save it to the table
      const url = await this.s3BucketService.getSignedURL(
        uploadedFile.Key,
        process.env.AWS_DEFAULT_S3_BUCKET,
      );

      if (!url) return badRequestRes('Failed to generate signed URL');

      uploadedFiles.push({ uploadedFile, url });

      tempMedia.push({
        url,
        filename: uploadedFile.key,
        mimetype: file.mimetype,
        originalname: file.originalname,
      });
    }

    if (!tempMedia.length) return badRequestRes('Unable to upload your media');

    // Update media in post
    const updatePost = await this.postsService.updateOnePrivate(
      _id,
      {
        media: tempMedia,
        status: tempMedia[0].mimetype.includes('image')
          ? EPostStatus.APPROVED
          : EPostStatus.PENDING,
      },
      user,
    );

    if (!updatePost) return badRequestRes('Failed to update post media');

    return successRes({ updatePost, uploadedFiles, tempMedia });
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
    @Body() approvePostRequestDto: ApprovePostRequestDto
  ) {
    const approvedPost = await this.postsService.approvePostEditRequest(
      userId,
      authUser.id,
      approvePostRequestDto.status
    );
    
    return approvedPost
      ? successRes({ user: approvedPost }, 'Request approved successfully')
      : badRequestRes('Failed to approve request');
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post()
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        caption: { type: 'string' },
        location: { type: 'string' },
        visibility: { type: 'string', enum: ['public', 'private', 'friends', 'custom'] },
        // status: { type: 'string', enum: ['pending', 'approved','rejected', 'draft', 'archived'] },
        media: {
          type: 'array',
          items: {
            type: 'string',
            format: 'binary',
          },
        },
      },
    },
  })
  @UseInterceptors(FilesInterceptor('media'))
  async create(
    @Body() createPostDto: CreatePostDto,
    @UploadedFiles() media: Express.Multer.File[],
    @AuthUser() user: IAuthUser,
  ) {
    const uploadedMedia: MediaDto[] = [];
  
    for (const file of media) {
      const uploadedFile: any = await this.s3BucketService.uploadFile(file, 'posts');
  
      if (!uploadedFile) {
        return badRequestRes('Failed to upload media file!');
      }
  
      const url = await this.s3BucketService.getSignedURL(uploadedFile.Key, process.env.AWS_DEFAULT_S3_BUCKET);
      
      if (!url) return badRequestRes('Failed to generate signed URL for media');
  
      uploadedMedia.push({
        url,
        filename: uploadedFile.key,
        mimetype: file.mimetype,
        originalname: file.originalname,
      });
    }
  
    if (!uploadedMedia.length) {
      return badRequestRes('No valid media files uploaded!');
    }
  
    const postData = {
      ...createPostDto,
      user: user.id,
      media: uploadedMedia,
    };
  
    const post = await this.postsService.create(postData);
  
    if (!post) return badRequestRes('Failed to create post!');
  
    return successRes(post);
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
  async findPublicFeeds(@Query() params: FilterPostDto, @AuthUser() user: IAuthUser) {
    const options: FilterPostDto = {
      ...DefaultFindParams,
      ...params,
      visibility: EPostVisibility.PUBLIC,
      status: EPostStatus.APPROVED,
    };

    const { posts, count } = await this.postsService.findAllPublic(options, user.id);


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
    const post = await this.postsService.findOne({ user: user, _id });

    if (!post) return badRequestRes('Post not found!');

    return successRes(post);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Put(':id')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        caption: { type: 'string' },
        location: { type: 'string' },
        visibility: { type: 'string', enum: ['public', 'private', 'friends', 'custom'] },
        status: { type: 'string', enum: ['pending', 'approved', 'rejected', 'draft', 'archived'] },
        media: {
          type: 'array',
          items: {
            type: 'string',
            format: 'binary',
          },
        },
      },
    },
  })
  @UseInterceptors(FilesInterceptor('media'))
  async update(
    @Param('id') _id: string,
    @Body() payload: UpdatePostDto,
    @UploadedFiles() media: Express.Multer.File[],
    @AuthUser() user: IAuthUser,
  ) {
    const post = await this.postsService.findByIdPrivate(_id, user.id);
  
    if (!post) return badRequestRes('Post not found!');
  
    let uploadedMedia: MediaDto[] = [];
    let mediaToDelete: string[] = [];
  
    if (media && media.length > 0) {
      uploadedMedia = [];
  
      for (const file of media) {
        const uploadedFile: any = await this.s3BucketService.uploadFile(file, 'posts');
  
        if (!uploadedFile) {
          return badRequestRes('Failed to upload media file!');
        }
  
        const url = await this.s3BucketService.getSignedURL(uploadedFile.Key, process.env.AWS_DEFAULT_S3_BUCKET);
  
        if (!url) return badRequestRes('Failed to generate signed URL for media');
  
        uploadedMedia.push({
          url,
          filename: uploadedFile.key,
          mimetype: file.mimetype,
          originalname: file.originalname,
        });
      }
    }
  
    if (post.media && post.media.length > 0) {
      post.media.forEach((existingMedia) => {
        const isNewFile = uploadedMedia.some((newMedia) => newMedia.filename === existingMedia.filename);
  
        if (!isNewFile) {
          mediaToDelete.push(existingMedia.filename);
        }
      });
    }
  
    for (const fileKey of mediaToDelete) {
      await this.s3BucketService.deleteOne(fileKey, process.env.AWS_DEFAULT_S3_BUCKET);
    }
  
    const updatedPostData = {
      ...payload,
      media: uploadedMedia.length > 0 ? uploadedMedia : post.media,
    };
  
    const updatePost = await this.postsService.updateOnePrivate(_id, updatedPostData, user);
  
    if (!updatePost) return badRequestRes('Failed to update post');
  
    return successRes(updatePost);
  }  

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  async remove(@Param('id') _id: string, @AuthUser() user: IAuthUser) {
    const post = await this.postsService.findById(_id);

    if (!post) return badRequestRes('Unable to delete your post!');

    const deletePost = await this.postsService.removePrivate(_id, user.id);

    // Delete media in posts
    for (const media of post.media) {
      await this.s3BucketService.deleteOne(
        media.filename,
        process.env.AWS_DEFAULT_S3_BUCKET,
      );
    }

    if (!deletePost.deletedCount)
      return badRequestRes('Unable to delete your post!');

    return successRes({ deleted: true }, 'Post deleted!');
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
        postId
      );
      return successRes({ updatedBookMark }, 'Post bookmark status updated successfully');
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
  @Post('comment')
  @ApiOperation({ summary: 'Add a comment on post' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Content of the comment' },
        post: { type: 'string', description: 'The post ID to which the comment belongs' }
      },
    },
  })
  async createComment(
    @Body() createCommentDto: CreateCommentDto,
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
    const result = await this.postsService.updateComment(postId, commentId, updateCommentDto, user.id);
    
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
    const result = await this.postsService.deleteComment(postId, commentId, user.id);

    if (result) {
      return successRes({ message: 'Comment deleted successfully' });
    } else {
      return badRequestRes('Failed to delete the comment');
    }
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post(':postId/like')
  @ApiOperation({ summary: 'Like a post' })
  @ApiResponse({ status: 200, description: 'Post liked successfully.' })
  @ApiResponse({ status: 400, description: 'You have already liked this post.' })
  async likePost(
    @Param('postId') postId: string,
    @AuthUser() user: IAuthUser,
  ) {
    const post = await this.postsService.likePost(postId, user.id);
    if (!post) {
      return { message: 'You have already liked this post.' };
    }
    return { message: 'Post liked successfully.', post };
  }
  
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Delete(':postId/unlike')
  @ApiOperation({ summary: 'Unlike a post' })
  @ApiResponse({ status: 200, description: 'Post unliked successfully.' })
  @ApiResponse({ status: 400, description: 'You have not liked this post yet.' })
  async unlikePost(
    @Param('postId') postId: string,
    @AuthUser() user: IAuthUser,
  ) {
    const post = await this.postsService.unlikePost(postId, user.id);
    if (!post) {
      return { message: 'You have not liked this post yet.' };
    }
    return { message: 'Post unliked successfully.', post };
  }
}
