import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Delete,
  UploadedFile,
  UseInterceptors,
  UploadedFiles,
  UseGuards,
  Query,
  Put,
} from '@nestjs/common';

import { AuthUser, Roles } from 'src/common/decorators';
import { DefaultFindParams, IAuthUser } from 'src/common/interfaces';

import { S3BucketService } from 'src/s3-bucket/s3-bucket.service';
import { badRequestRes, successRes } from 'src/common/interceptors';
import { JwtAuthGuard, RolesGuard } from 'src/common/guards';
import { FilterPostDto } from '../dto/filter-post.dto';
import { ERole } from 'src/common/enums';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PostsService } from '../posts.service';
import { UpdatePostDto } from '../dto/update-post.dto';

@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(ERole.ADMIN)
@ApiTags('Admin Posts')
@Controller('admin/posts')
export class AdminPostsController {
  constructor(
    private readonly postsService: PostsService,
    private readonly s3BucketService: S3BucketService,
  ) {}

  @Get()
  async findAll(@Query() params: FilterPostDto) {
    const options = {
      ...DefaultFindParams,
      ...params,
    };

    const { posts, count } = await this.postsService.findAll(options);

    return successRes({ posts, count });
  }

  @Put(':id')
  async update(@Param('id') _id: string, @Body() payload: UpdatePostDto) {
    const post = await this.postsService.findById(_id);

    if (!post) return badRequestRes('Post not found!');

    const updatePost = await this.postsService.updateOne(_id, payload);

    if (!updatePost) return badRequestRes('Failed to update post');

    return successRes(updatePost);
  }
}
