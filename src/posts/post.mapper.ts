/** In-process marker; JSON/client objects cannot forge it. */
const mappedImage = Symbol('mapped-post-image');
export const isMappedPostImage = (value: any) => value?.[mappedImage] === true;

export function isPremium(viewer?: { premiumUntil?: Date | string | null }, now = Date.now()) {
  return !!viewer?.premiumUntil && new Date(viewer.premiumUntil).getTime() > now;
}

export interface PostViewer {
  id?: string;
  premiumUntil?: Date | string | null;
  /** Only supplied by the interceptor on the existing guarded admin controller. */
  admin?: boolean;
}

interface PostMediaDelivery {
  canRead: () => Promise<boolean>;
  original: (image: any) => Promise<string>;
  preview: (key?: string) => string;
  /** Signs one bound post video; resolves '' when it is unavailable. */
  video?: (video: any) => Promise<string>;
}

export class PostMapper {
  async toResponse(post: any, viewer: PostViewer, delivery: PostMediaDelivery) {
    // Audience/block/moderation authorization ALWAYS precedes entitlement or signing.
    if (!await delivery.canRead()) return null;
    const owner = String(post.user?._id || post.user);
    const contentVisibility = post.contentVisibility || 'normal';
    const locked = contentVisibility === 'premium' && !viewer.admin && viewer.id !== owner && !isPremium(viewer);
    const images = await Promise.all((post.media || []).map(async (image: any, index: number) => {
      // Never spread image documents: even authorized viewers get only these fields.
      const result = {
        id: String(image.photoId || image._id || `${post._id}:${index}`),
        url: locked ? delivery.preview(image.previewKey) : await delivery.original(image),
        blurhash: image.blurhash || null,
        // Stored after EXIF orientation is applied; null for legacy rows until backfilled.
        width: image.width || null,
        height: image.height || null,
        aspectRatio:
          image.width > 0 && image.height > 0 ? Math.round((image.width / image.height) * 10000) / 10000 : null,
      };
      Object.defineProperty(result, mappedImage, { value: true });
      return result;
    }));
    // Locked videos have no preview frame: nothing is signed for them.
    const videos = await Promise.all((post.videos || []).map(async (video: any) => {
      const result = {
        id: String(video.videoId || ''),
        url: locked || !delivery.video ? '' : await delivery.video(video),
        contentType: video.contentType === 'video/quicktime' ? 'video/quicktime' : 'video/mp4',
      };
      Object.defineProperty(result, mappedImage, { value: true });
      return result;
    }));
    const result: Record<string, any> = {};
    for (const field of ['_id', 'caption', 'location', 'tags', 'user', 'visibility', 'status',
      'createdAt', 'updatedAt', 'likes', 'comments', 'likeCount', 'commentCount',
      'likedByMe', 'followStatus', 'isBookmarked']) {
      if (post[field] !== undefined) result[field] = post[field];
    }
    // Moderation flags are staff-only metadata.
    if (viewer.admin && post.flag) {
      const flag = { reason: post.flag.reason, note: post.flag.note || '', hidden: !!post.flag.hidden, at: post.flag.at };
      Object.defineProperty(flag, mappedImage, { value: true });
      result.flag = flag;
    }
    return { ...result, contentVisibility, locked, images, videos };
  }
}
