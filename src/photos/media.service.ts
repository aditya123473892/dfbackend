import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import sharp = require('sharp');
import { S3BucketService } from '../s3-bucket/s3-bucket.service';

const BASE83 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';

/** A valid one-component BlurHash: average preview colour, no recoverable detail. */
function averageBlurhash(rgb: Buffer) {
  let colour = (rgb[0] << 16) + (rgb[1] << 8) + rgb[2];
  let encoded = '';
  for (let power = 3; power >= 0; power--) {
    const divisor = 83 ** power;
    encoded += BASE83[Math.floor(colour / divisor)];
    colour %= divisor;
  }
  return `00${encoded}`;
}

export function originalUrlSeconds() {
  const seconds = Number(process.env.POST_IMAGE_URL_SECONDS || 900);
  if (!Number.isInteger(seconds) || seconds < 300 || seconds > 3600)
    throw new ServiceUnavailableException('POST_IMAGE_URL_SECONDS must be between 300 and 3600');
  return seconds;
}

export class MediaService {
  constructor(private readonly storage: S3BucketService) {}

  // TODO: move decoding/preview work to a durable queue when one is configured.
  // Invoked at confirm, after sanitation/moderation, never during post creation.
  async buildPreview(bytes: Buffer, previewKey: string) {
    if (!/^previews\/[a-f\d]{24}\/[a-f\d-]{36}\.jpg$/.test(previewKey))
      throw new BadRequestException('Invalid preview reference');
    const { width, height } = await sharp(bytes).metadata();
    const preview = await sharp(bytes)
      .rotate()
      .resize({ width: 320, height: 320, fit: 'inside', withoutEnlargement: true })
      .blur(24)
      .jpeg({ quality: 20 })
      .toBuffer();
    const rgb = await sharp(preview).resize(1, 1).removeAlpha().raw().toBuffer();
    await this.storage.putPreview(previewKey, preview);
    return { previewKey, blurhash: averageBlurhash(rgb), width, height };
  }

  signedGet(key: string) {
    return this.storage.getSignedURL(key, undefined, originalUrlSeconds(), true);
  }

  previewUrl(key?: string) {
    if (!key || !/^previews\/[a-f\d]{24}\/[a-f\d-]{36}\.jpg$/.test(key)) return '';
    const configured = process.env.PHOTO_PREVIEW_BASE_URL;
    if (!configured) throw new ServiceUnavailableException('Photo previews are not configured');
    const base = new URL(configured);
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/')
      throw new ServiceUnavailableException('PHOTO_PREVIEW_BASE_URL must be an HTTPS origin');
    return new URL(key, base).toString();
  }
}
