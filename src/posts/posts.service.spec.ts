import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { PostsService } from './posts.service';
import { S3BucketService } from 'src/s3-bucket/s3-bucket.service';

export const postsModelProviders = ['Posts', 'Comment', 'Like', 'Follow', 'PostRequest', 'PostBookMark'].map(
  (name) => ({ provide: getModelToken(name), useValue: {} }),
);

describe('PostsService', () => {
  let service: PostsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PostsService, ...postsModelProviders, { provide: S3BucketService, useValue: {} }],
    }).compile();

    service = module.get<PostsService>(PostsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
