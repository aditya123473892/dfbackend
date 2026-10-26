import { PostMapper, isMappedPostImage } from './post.mapper';

describe('PostMapper', () => {
  const post = {
    _id: 'post-id', user: 'author', visibility: 'public', status: 'approved',
    contentVisibility: 'premium', caption: 'Caption',
    media: [{ photoId: 'photo-id', filename: 'posts/author/original.jpg',
      originalKey: 'secret-original', previewKey: 'previews/blurred.jpg',
      storageKey: 'secret-storage', blurhash: '00TI:j', width: 1080, height: 720 }],
  };
  const mapper = new PostMapper();
  const delivery = () => ({ canRead: jest.fn().mockResolvedValue(true),
    original: jest.fn().mockResolvedValue('https://s3.test/original.jpg?X-Amz-Signature=secret'),
    preview: jest.fn().mockReturnValue('https://cdn.test/previews/blurred.jpg') });

  it.each([
    ['non-subscriber', { id: 'viewer' }, true],
    ['subscriber', { id: 'viewer', premiumUntil: new Date(Date.now() + 60000) }, false],
    ['author', { id: 'author' }, false],
    ['expired', { id: 'viewer', premiumUntil: new Date(Date.now() - 1) }, true],
    ['guarded admin', { id: 'admin', admin: true }, false],
  ])('maps premium for %s', async (_label, viewer, locked) => {
    const media = delivery();
    const response = await mapper.toResponse(post, viewer, media);
    expect(response.locked).toBe(locked);
    expect(response.images[0].url).toBe(locked ? 'https://cdn.test/previews/blurred.jpg' : 'https://s3.test/original.jpg?X-Amz-Signature=secret');
    expect(Object.keys(response.images[0]).sort()).toEqual(['aspectRatio', 'blurhash', 'height', 'id', 'url', 'width']);
    expect(response.images[0]).toMatchObject({ width: 1080, height: 720, aspectRatio: 1.5 });
    expect(isMappedPostImage(response.images[0])).toBe(true);
    const json = JSON.stringify(response);
    for (const field of ['originalKey', 'previewKey', 'filename', 'storageKey', 'secret-original', 'secret-storage']) expect(json).not.toContain(field);
    if (locked) {
      expect(json).not.toContain('original.jpg');
      expect(json).not.toContain('X-Amz-');
      expect(media.original).not.toHaveBeenCalled();
    }
  });

  it('unlocks normal images without a subscription', async () => {
    expect((await mapper.toResponse({ ...post, contentVisibility: 'normal' }, { id: 'viewer' }, delivery())).locked).toBe(false);
  });

  it.each(['audience', 'block', 'moderation'])('omits posts denied by %s before looking at premium', async () => {
    const media = delivery();
    media.canRead.mockResolvedValue(false);
    const premiumUntil = jest.fn(() => { throw new Error('Entitlement evaluated before authorization'); });
    expect(await mapper.toResponse(post, { id: 'author', get premiumUntil() { return premiumUntil(); } }, media)).toBeNull();
    expect(media.original).not.toHaveBeenCalled();
    expect(media.preview).not.toHaveBeenCalled();
    expect(premiumUntil).not.toHaveBeenCalled();
  });

  it('locks safely when a legacy image has no preview', async () => {
    const media = delivery(); media.preview.mockReturnValue('');
    const result = await mapper.toResponse({ ...post, media: [{ filename: 'original.jpg' }] }, { id: 'viewer' }, media);
    expect(result.images[0].url).toBe('');
    expect(media.original).not.toHaveBeenCalled();
  });
});
