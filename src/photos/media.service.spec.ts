import sharp = require('sharp');
import { MediaService, originalUrlSeconds } from './media.service';

describe('Premium previews', () => {
  const previewKey = 'previews/507f1f77bcf86cd799439011/12345678-1234-4234-8234-123456789abc.jpg';
  const previousPreviewBase = process.env.PHOTO_PREVIEW_BASE_URL;
  afterEach(() => {
    if (previousPreviewBase === undefined) delete process.env.PHOTO_PREVIEW_BASE_URL;
    else process.env.PHOTO_PREVIEW_BASE_URL = previousPreviewBase;
  });

  it('signs only a blurred preview when no CDN is configured', async () => {
    delete process.env.PHOTO_PREVIEW_BASE_URL;
    const getSignedURL = jest.fn().mockResolvedValue('https://private.test/blurred-preview?signature=preview');
    const url = await new MediaService({ getSignedURL } as any).previewUrl(previewKey);
    expect(url).toBe('https://private.test/blurred-preview?signature=preview');
    expect(getSignedURL).toHaveBeenCalledWith(previewKey, undefined, 900, true);
  });

  it('retains CDN delivery and rejects invalid origins without signing a fallback', async () => {
    const getSignedURL = jest.fn();
    const media = new MediaService({ getSignedURL } as any);
    process.env.PHOTO_PREVIEW_BASE_URL = 'https://preview.test';
    expect(await media.previewUrl(previewKey)).toBe('https://preview.test/' + previewKey);
    for (const origin of ['http://preview.test', 'https://user:password@preview.test', 'https://preview.test/originals/']) {
      process.env.PHOTO_PREVIEW_BASE_URL = origin;
      await expect(media.previewUrl(previewKey)).rejects.toThrow();
    }
    expect(getSignedURL).not.toHaveBeenCalled();
  });

  it.each([undefined, '', 'posts/author/original.jpg', '../original.jpg', 'https://original.test/photo', previewKey + '/../original.jpg'])('never signs an invalid preview reference: %s', async key => {
    delete process.env.PHOTO_PREVIEW_BASE_URL;
    const getSignedURL = jest.fn();
    expect(await new MediaService({ getSignedURL } as any).previewUrl(key)).toBe('');
    expect(getSignedURL).not.toHaveBeenCalled();
  });

  it('writes a small blurred JPEG without EXIF and a valid constant BlurHash', async () => {
    const putPreview = jest.fn();
    const media = new MediaService({ putPreview } as any);
    const input = await sharp({ create: { width: 960, height: 640, channels: 3, background: 'red' } })
      .withMetadata().jpeg().toBuffer();
    const key = 'previews/507f1f77bcf86cd799439011/12345678-1234-4234-8234-123456789abc.jpg';
    const result = await media.buildPreview(input, key);
    const bytes = putPreview.mock.calls[0][1];
    const metadata = await sharp(bytes).metadata();
    expect(metadata.width).toBe(320);
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
    expect(metadata.format).toBe('jpeg');
    expect(bytes.length).toBeLessThan(input.length);
    expect(result).toMatchObject({ previewKey: key, width: 960, height: 640 });
    expect(result.blurhash).toMatch(/^00.{4}$/);
  });

  it('removes high-frequency image details', async () => {
    const pixels = Buffer.alloc(320 * 320 * 3);
    for (let i = 0; i < 320 * 320; i++) pixels.fill(i % 2 ? 255 : 0, i * 3, i * 3 + 3);
    const input = await sharp(pixels, { raw: { width: 320, height: 320, channels: 3 } }).jpeg().toBuffer();
    const putPreview = jest.fn();
    await new MediaService({ putPreview } as any).buildPreview(input,
      'previews/507f1f77bcf86cd799439011/12345678-1234-4234-8234-123456789abc.jpg');
    const stats = await sharp(putPreview.mock.calls[0][1]).stats();
    expect(stats.channels[0].stdev).toBeLessThan(20);
  });

  it('uses 15-minute URLs and refuses out-of-range configuration', () => {
    const previous = process.env.POST_IMAGE_URL_SECONDS;
    try {
      delete process.env.POST_IMAGE_URL_SECONDS;
      expect(originalUrlSeconds()).toBe(900);
      process.env.POST_IMAGE_URL_SECONDS = '120';
      expect(originalUrlSeconds).toThrow();
    } finally {
      if (previous === undefined) delete process.env.POST_IMAGE_URL_SECONDS;
      else process.env.POST_IMAGE_URL_SECONDS = previous;
    }
  });
});
