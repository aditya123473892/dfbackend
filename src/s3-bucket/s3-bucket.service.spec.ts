import { Test, TestingModule } from '@nestjs/testing';
import { S3BucketService } from './s3-bucket.service';

describe('S3BucketService', () => {
  let service: S3BucketService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [S3BucketService],
    }).compile();

    service = module.get<S3BucketService>(S3BucketService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
