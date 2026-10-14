import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventsService } from 'src/events/events.service';
import { PostsService } from 'src/posts/posts.service';
import { S3BucketService } from 'src/s3-bucket/s3-bucket.service';

@Injectable()
export class ImageURLService {
  private readonly logger = new Logger(ImageURLService.name);
  constructor(
    private readonly eventsService: EventsService,
    private readonly postsService: PostsService,
    private readonly s3BucketService: S3BucketService,
  ) {}

  @Cron(CronExpression.EVERY_2_HOURS)
  async regenerateSignedURL() {
    this.logger.debug('Re-generate signed urls for POST, EVENTS, AVATAR');

    const events = await this.eventsService.findExpiredURLEvents(100);

    for (const event of events) {
      try {
        if (!event.cover?.filename) continue;

        const url = await this.s3BucketService.getSignedURL(
          event.cover.filename,
          process.env.AWS_DEFAULT_S3_BUCKET,
        );

        if (url)
          await this.eventsService.addCover(event._id.toString(), {
            ...event.cover,
            url,
          });
      } catch (error) {
        this.logger.error(
          `Failed to regenerate event cover URL for ${event._id}: ${error?.message || error}`,
        );
      }
    }

    const posts = await this.postsService.findExpiredURLPost(100);

    for (const post of posts) {
      let media = [];

      for (const iterator of post.media || []) {
        if (!iterator.filename) continue;

        const url = await this.s3BucketService.getSignedURL(
          iterator.filename,
          process.env.AWS_DEFAULT_S3_BUCKET,
        );

        if (url) media.push({ ...iterator, url });
      }

      if (media.length > 0)
        await this.postsService.updateOne(post._id.toString(), { media });
    }

    this.logger.debug('CRON Executed');
  }
}
