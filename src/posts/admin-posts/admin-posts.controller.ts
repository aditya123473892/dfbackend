import {
  Controller,
  Get,
  Patch,
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
  ValidationPipe,
  BadRequestException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { PhotosService } from '../../photos/photos.service';
import { AdminPhotoPostDto, AdminCreatePhotoPostDto } from '../dto/admin-photo-post.dto';

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
import { AdminMediaService, flagInput, mediaListInput, parseAdmin, visibilityInput } from './admin-media.service';

@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(ERole.ADMIN)
@ApiTags('Admin Posts')
@Controller('admin/posts')
export class AdminPostsController {
  constructor(
    private readonly postsService: PostsService,
    private readonly s3BucketService: S3BucketService,
    private readonly photos: PhotosService,
    private readonly media?: AdminMediaService,
  ) {}

  /** Review list of post photos/videos; signed for admins by the response interceptor. */
  @Get('media')
  async listMedia(@Query() query: Record<string, unknown>) {
    return successRes(await this.media.list(parseAdmin(mediaListInput, query)));
  }

  /** Switch a post between normal and premium (subscriber-only) content. */
  @Patch(':id/content-visibility')
  async setContentVisibility(@AuthUser() actor: IAuthUser, @Param('id') id: string, @Body() body: unknown) {
    return successRes(await this.media.setVisibility(actor.id, id, parseAdmin(visibilityInput, body).contentVisibility));
  }

  /** Flag (optionally hiding from everyone but the owner) or unflag a post. */
  @Patch(':id/flag')
  async setFlag(@AuthUser() actor: IAuthUser, @Param('id') id: string, @Body() body: unknown) {
    return successRes(await this.media.setFlag(actor.id, id, parseAdmin(flagInput, body)));
  }

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
  async update(@Param('id') _id: string, @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })) payload: AdminPhotoPostDto) {
    if ('media' in payload || 'user' in payload) throw new BadRequestException('Use upload IDs only');
    const post = await this.postsService.findById(_id);

    if (!post) return badRequestRes('Post not found!');

    const author = String((post.user as any)?._id || post.user);
    const media = payload.photoIds ? await this.photos.bind(author, payload.photoIds, `post:${_id}`) : post.media;
    const patch: any = {};
    if (payload.photoIds) patch.media = media;
    for (const field of ['caption', 'location', 'visibility', 'contentVisibility', 'status'])
      if (payload[field] !== undefined) patch[field] = payload[field];
    const updatePost = await this.postsService.updateOne(_id, patch);

    if (!updatePost) return badRequestRes('Failed to update post');
    if (payload.photoIds) {
      const keep = new Set(media.map(item => item.filename));
      await this.photos.retire(`post:${_id}`, (post.media || []).filter(item => !keep.has(item.filename)).map(item => item.filename));
    }

    return successRes(updatePost);
  }
  @Post()
  async create(@Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })) payload: AdminCreatePhotoPostDto) {
    if ('media' in payload) throw new BadRequestException('Use upload IDs only');
    const id = new Types.ObjectId().toString();
    const media = await this.photos.bind(payload.user, payload.photoIds || [], `post:${id}`);
    const patch: any = { _id: id, user: payload.user, media };
    for (const field of ['caption', 'location', 'visibility', 'contentVisibility', 'status'])
      if (payload[field] !== undefined) patch[field] = payload[field];
    return successRes(await this.postsService.create(patch));
  }
}
