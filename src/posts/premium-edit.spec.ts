import { PostsController } from './posts.controller';
import { AdminPostsController } from './admin-posts/admin-posts.controller';
import { EContentVisibility } from '../common/enums/posts.enum';

describe('Content tier edits preserve media storage', () => {
  const id = '507f1f77bcf86cd799439011';
  it.each([EContentVisibility.NORMAL, EContentVisibility.PREMIUM])('author edit to %s writes only the tier', async contentVisibility => {
    const post = { user: id, media: [{ filename: 'unchanged-original', previewKey: 'unchanged-preview' }], __v: 3 };
    const posts: any = { findByIdPrivate: jest.fn(async () => post), updateOnePrivate: jest.fn(async () => post), findVisiblePost: jest.fn(async () => post) };
    const photos: any = { bind: jest.fn(), retire: jest.fn(), enqueue: jest.fn() };
    const actor: any = { id };
    await new PostsController(posts, photos, {} as any, {} as any).update(id, { contentVisibility }, actor);
    expect(posts.updateOnePrivate).toHaveBeenCalledWith(id, { contentVisibility }, actor, 3);
    expect(photos.bind).not.toHaveBeenCalled(); expect(photos.retire).not.toHaveBeenCalled();
    expect(post.media[0].previewKey).toBe('unchanged-preview');
  });
  it('admin tier edit also avoids rewriting media', async () => {
    const posts: any = { findById: jest.fn(async () => ({ user: id, media: [] })), updateOne: jest.fn(async () => ({})) };
    const photos: any = { bind: jest.fn() };
    await new AdminPostsController(posts, {} as any, photos).update(id, { contentVisibility: EContentVisibility.PREMIUM });
    expect(posts.updateOne).toHaveBeenCalledWith(id, { contentVisibility: 'premium' });
    expect(photos.bind).not.toHaveBeenCalled();
  });
});
