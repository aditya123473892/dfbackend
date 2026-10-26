import { Test, TestingModule } from '@nestjs/testing';
import { PostsController } from './posts.controller';
import { PostsService } from './posts.service';

describe('PostsController', () => {
  let controller: PostsController;
  let service: PostsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PostsController],
      providers: [PostsService],
    }).useMocker(() => ({})).compile();

    controller = module.get<PostsController>(PostsController);
    service = module.get<PostsService>(PostsService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('returns an authoritative like envelope even when the like already exists', async () => {
    jest.spyOn(service, 'likePost').mockResolvedValue(null);
    jest.spyOn(service, 'getLikeState').mockResolvedValue({ liked: true, likeCount: 12 });
    const response = await controller.likePost('post', { id: 'viewer' } as never);
    expect(response.data).toEqual({ liked: true, likeCount: 12 });
    expect(response.error).toBe(false);
    expect(service.getLikeState).toHaveBeenCalledWith('post', 'viewer');
  });

  it('returns a confirmed unlike count even when the like is already absent', async () => {
    jest.spyOn(service, 'unlikePost').mockResolvedValue(null);
    jest.spyOn(service, 'getLikeState').mockResolvedValue({ liked: false, likeCount: 11 });
    expect((await controller.unlikePost('post', { id: 'viewer' } as never)).data).toEqual({ liked: false, likeCount: 11 });
  });
});
