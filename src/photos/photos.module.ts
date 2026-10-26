import { Global, Module } from '@nestjs/common';
import { PhotosService } from './photos.service';
import { PhotosController } from './photos.controller';
import { S3BucketService } from '../s3-bucket/s3-bucket.service';
import { PhotoResponseInterceptor } from './response.interceptor';
import { VideosService } from './videos.service';
import { VideosController } from './videos.controller';

@Global()
@Module({
  providers: [PhotosService, VideosService, S3BucketService, PhotoResponseInterceptor],
  controllers: [PhotosController, VideosController],
  exports: [PhotosService, VideosService, PhotoResponseInterceptor],
})
export class PhotosModule {}
