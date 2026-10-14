import { Test, TestingModule } from '@nestjs/testing';
import { AdminPostsController } from './admin-posts.controller';

describe('AdminPostsController', () => {
  let controller: AdminPostsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminPostsController],
    }).compile();

    controller = module.get<AdminPostsController>(AdminPostsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
