import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { AdminPostsController } from './admin-posts.controller';
import { AdminPhotoPostDto, AdminCreatePhotoPostDto } from '../dto/admin-photo-post.dto';
import { PhotosService } from '../../photos/photos.service';

describe('Admin post resource isolation', () => {
  const owner = '507f1f77bcf86cd799439011';
  const postId = '507f1f77bcf86cd799439012';
  const upload = '7cfab11e-a5fb-43c7-987d-bda2b67d975a';
  function setup() {
    const posts: any = { findById: jest.fn(async () => ({ user: { _id: owner }, media: [{ filename: 'old-key' }] })), updateOne: jest.fn(async () => ({})), create: jest.fn(async () => ({})) };
    const photos: any = { bind: jest.fn(async () => [{ filename: 'new-key' }]), retire: jest.fn() };
    return { controller: new AdminPostsController(posts, {} as any, photos), posts, photos };
  }
  it('binds against the persisted post author and queues retired media', async () => {
    const { controller, photos, posts } = setup();
    await controller.update(postId, { photoIds: [upload] });
    expect(photos.bind).toHaveBeenCalledWith(owner, [upload], `post:${postId}`);
    expect(posts.updateOne).toHaveBeenCalledWith(postId, { media: [{ filename: 'new-key' }] });
    expect(photos.retire).toHaveBeenCalledWith(`post:${postId}`, ['old-key']);
  });
  it('denies another user\'s chat upload through the real binding service', async () => {
    const { posts } = setup();
    const uploads = { findOne: jest.fn(async () => null) };
    const db: any = { db: { collection: (name: string) => name === 'PhotoUploads' ? uploads : { findOne: async () => name === 'Users' ? { _id: owner } : null } } };
    const controller = new AdminPostsController(posts, {} as any, new PhotosService(db, {} as any));
    await expect(controller.update(postId, { photoIds: [upload] })).rejects.toThrow(BadRequestException);
    expect(uploads.findOne).toHaveBeenCalledWith(expect.objectContaining({ owner, _id: upload, $or: [{ state: 'approved' }, { state: 'attached', ref: `post:${postId}` }] }));
    expect(posts.updateOne).not.toHaveBeenCalled();
  });
  it('creates with upload IDs and a backend resource ID', async () => {
    const { controller, photos } = setup();
    await controller.create({ user: owner, photoIds: [upload] });
    expect(photos.bind).toHaveBeenCalledWith(owner, [upload], expect.stringMatching(/^post:[0-9a-f]{24}$/));
  });
  it('rejects raw media and keys through both DTOs', async () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true });
    for (const metatype of [AdminPhotoPostDto, AdminCreatePhotoPostDto])
      await expect(pipe.transform({ user: owner, photoIds: [upload], media: [{ filename: 'chat/victim.jpg' }] }, { type: 'body', metatype })).rejects.toThrow(BadRequestException);
  });
  it('text-only edits preserve media', async () => {
    const { controller, photos } = setup();
    await controller.update(postId, { caption: 'Updated' });
    expect(photos.bind).not.toHaveBeenCalled(); expect(photos.retire).not.toHaveBeenCalled();
  });
});
