import { Test, TestingModule } from '@nestjs/testing';
import { AdminPostsController } from './admin-posts.controller';
import { PostsService } from '../posts.service';
import { S3BucketService } from 'src/s3-bucket/s3-bucket.service';

describe('AdminPostsController', () => {
  let controller: AdminPostsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminPostsController],
      providers: [
        { provide: PostsService, useValue: {} },
        { provide: S3BucketService, useValue: {} },
      ],
    }).compile();

    controller = module.get<AdminPostsController>(AdminPostsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
