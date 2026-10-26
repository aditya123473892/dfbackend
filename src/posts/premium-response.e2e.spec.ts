import { Controller, Get, Post, Put, Delete, UseGuards, Injectable, CanActivate, ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { Types } from 'mongoose';
import { PhotoResponseInterceptor } from '../photos/response.interceptor';
import { PhotosService } from '../photos/photos.service';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators';
import { ERole } from '../common/enums';

const owner = '507f1f77bcf86cd799439011';
const viewerId = '507f1f77bcf86cd799439012';
const postId = '507f1f77bcf86cd799439013';
const key = `posts/${owner}/${postId}/secret-original.jpg`;
const previewKey = `previews/${owner}/12345678-1234-4234-8234-123456789abc.jpg`;
const photoId = '12345678-1234-4234-8234-123456789abc';
let post: any;
let viewer: any;
let blocked: boolean;

@Injectable()
class Identity implements CanActivate {
  canActivate(context: ExecutionContext) {
    context.switchToHttp().getRequest().user = viewer;
    return true;
  }
}

@Controller('posts')
@UseGuards(Identity)
class SocialController {
  @Get('feed') feed() { return { posts: [post] }; }
  @Get('bookmarks') bookmarks() { return { bookMark: [{ postId: post }] }; }
  @Get('profile') profile() { return { usersPost: [post] }; }
  @Get(':id') single() { return post; }
  @Post() create() { return post; }
  @Put(':id') edit() { return post; }
  @Post(':id/like') like() { return { post }; }
  @Delete(':id/unlike') unlike() { return { post }; }
}

// Uses the actual admin role guard; this name is the production interceptor boundary.
@Controller('admin/posts')
@UseGuards(Identity, RolesGuard)
@Roles(ERole.ADMIN)
class AdminPostsController {
  @Get() list() { return { posts: [post] }; }
}

describe('Premium HTTP response pipeline', () => {
  let app: INestApplication;
  const storage = {
    keyFromReference: (value?: string) => value,
    getSignedURL: jest.fn(async () => `https://s3.test/${key}?X-Amz-Signature=secret`),
  };
  const db: any = { db: { collection: (name: string) => ({
    findOne: async (filter: any) => {
      if (name === 'Posts') return String(filter._id) === postId ? post : null;
      if (name === 'Users') {
        const id = String(filter._id);
        return [owner, viewerId].includes(id) ? { _id: new Types.ObjectId(id), premiumUntil: id === viewer.id ? viewer.premiumUntil : null } : null;
      }
      if (name === 'UserBlocks') return blocked ? {} : null;
      if (name === 'PhotoUploads') return { _id: photoId, owner, key, ref: `post:${postId}`, state: 'attached' };
      return null;
    },
  }) } };

  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [SocialController, AdminPostsController], providers: [Identity, RolesGuard] }).compile();
    app = module.createNestApplication();
    app.useGlobalInterceptors(new PhotoResponseInterceptor(new PhotosService(db, storage as any)));
    await app.init();
  });
  beforeEach(() => {
    process.env.PHOTO_PREVIEW_BASE_URL = 'https://cdn.test';
    viewer = { id: viewerId, roles: ['user'] }; blocked = false;
    post = { _id: new Types.ObjectId(postId), user: new Types.ObjectId(owner), status: 'approved',
      visibility: 'public', contentVisibility: 'premium', caption: 'Premium photo',
      media: [{ photoId, filename: key, storageKey: key, s3Key: key, previewKey, width: 1080, height: 720 }] };
    storage.getSignedURL.mockClear();
  });
  afterAll(async () => { await app.close(); delete process.env.PHOTO_PREVIEW_BASE_URL; });

  it.each([
    ['get', '/posts/feed'], ['get', '/posts/one'], ['get', '/posts/bookmarks'], ['get', '/posts/profile'],
    ['post', '/posts'], ['put', '/posts/one'], ['post', '/posts/one/like'], ['delete', '/posts/one/unlike'],
  ])('%s %s cannot expose any original through the recursive signer', async (method, path) => {
    const result = await (request(app.getHttpServer()) as any)[method](path).expect(200 + (method === 'post' ? 1 : 0));
    expect(result.headers['cache-control']).toBe('private, no-store');
    const json = JSON.stringify(result.body);
    expect(json).toContain('https://cdn.test/previews/');
    for (const secret of [key, 'originalKey', 'filename', 's3Key', 'storageKey', 'previewKey', 'X-Amz-', 's3.test']) expect(json).not.toContain(secret);
    expect(storage.getSignedURL).not.toHaveBeenCalled();
  });

  it.each(['private', 'friends', 'custom'])('does not return audience %s to a subscriber', async visibility => {
    post.visibility = visibility;
    viewer.premiumUntil = new Date(Date.now() + 60000);
    expect((await request(app.getHttpServer()).get('/posts/feed')).body.posts).toEqual([]);
    expect(storage.getSignedURL).not.toHaveBeenCalled();
  });
  it.each(['block', 'moderation'])('does not return a post denied by %s to a subscriber', async reason => {
    if (reason === 'block') blocked = true; else post.status = 'pending';
    viewer.premiumUntil = new Date(Date.now() + 60000);
    expect((await request(app.getHttpServer()).get('/posts/feed')).body.posts).toEqual([]);
  });
  it('rechecks subscriptions each request, including expiry, and always unlocks for author', async () => {
    viewer.premiumUntil = new Date(Date.now() + 60000);
    expect((await request(app.getHttpServer()).get('/posts/one')).body.locked).toBe(false);
    expect(storage.getSignedURL).toHaveBeenCalledWith(key, undefined, 900, true);
    viewer.premiumUntil = new Date(Date.now() - 1);
    expect((await request(app.getHttpServer()).get('/posts/one')).body.locked).toBe(true);
    viewer.id = owner;
    expect((await request(app.getHttpServer()).get('/posts/one')).body.locked).toBe(false);
  });
  it('applies tier edits on the next response without rewriting image data', async () => {
    post.contentVisibility = 'normal';
    expect((await request(app.getHttpServer()).get('/posts/one')).body.locked).toBe(false);
    post.contentVisibility = 'premium';
    expect((await request(app.getHttpServer()).get('/posts/one')).body.locked).toBe(true);
  });
  it('fails closed if a stored preview reference points at an original', async () => {
    post.media[0].previewKey = key;
    const response = await request(app.getHttpServer()).get('/posts/one').expect(200);
    expect(response.body.locked).toBe(true);
    expect(response.body.images[0].url).toBe('');
    expect(JSON.stringify(response.body)).not.toContain(key);
    expect(storage.getSignedURL).not.toHaveBeenCalled();
  });
  it('rejects non-admin access and unlocks guarded admin responses without granting social bypass', async () => {
    await request(app.getHttpServer()).get('/admin/posts').expect(403);
    viewer.roles = ['admin'];
    const result = await request(app.getHttpServer()).get('/admin/posts').expect(200);
    expect(result.body.posts[0].locked).toBe(false);
    expect((await request(app.getHttpServer()).get('/posts/one')).body.locked).toBe(true);
  });
});
