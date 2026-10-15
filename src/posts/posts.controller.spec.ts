import { BadRequestException, NotFoundException, UnsupportedMediaTypeException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PostsController } from './posts.controller';
import { PostsService } from './posts.service';
import { S3BucketService } from 'src/s3-bucket/s3-bucket.service';

const user = { id: '507f1f77bcf86cd799439011', roles: ['user'] } as any;
const jpeg = {
  originalname: 'photo.jpg',
  mimetype: 'image/jpeg',
  size: 20,
  buffer: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(17)]),
} as Express.Multer.File;

describe('PostsController', () => {
  let controller: PostsController;
  let posts: Record<string, jest.Mock>;
  let s3: Record<string, jest.Mock>;

  beforeEach(async () => {
    posts = {
      create: jest.fn(async (data) => ({ _id: 'p1', ...data })),
      toClientPost: jest.fn(async (post) => post),
      deleteOwnPost: jest.fn(),
      likePost: jest.fn(async () => ({ postId: 'p1', liked: true, likeCount: 1 })),
    };
    s3 = {
      uploadFile: jest.fn(async () => ({ Key: 'posts/1-photo.jpg' })),
      getSignedURL: jest.fn(async () => 'https://signed.example/x'),
      deleteOne: jest.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PostsController],
      providers: [
        { provide: PostsService, useValue: posts },
        { provide: S3BucketService, useValue: s3 },
      ],
    }).compile();

    controller = module.get<PostsController>(PostsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('ignores a client-sent status so authors cannot self-approve posts', async () => {
    await controller.create({ caption: ' hi ', status: 'approved', visibility: 'public' } as any, [jpeg], user);
    const saved = posts.create.mock.calls[0][0];
    expect(saved).not.toHaveProperty('status');
    expect(saved).toMatchObject({ caption: 'hi', user: user.id, media: [{ filename: 'posts/1-photo.jpg' }] });
  });

  it('rejects posts without media and files whose content is not an allowed image or video', async () => {
    await expect(controller.create({} as any, [], user)).rejects.toBeInstanceOf(BadRequestException);
    const html = { ...jpeg, mimetype: 'text/html', buffer: Buffer.from('<script>alert(1)</script>') } as Express.Multer.File;
    await expect(controller.create({} as any, [html], user)).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
    const fakeJpeg = { ...jpeg, buffer: Buffer.alloc(20) } as Express.Multer.File;
    await expect(controller.create({} as any, [fakeJpeg], user)).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
    expect(s3.uploadFile).not.toHaveBeenCalled();
  });

  it('removes already uploaded files when a later upload fails', async () => {
    s3.uploadFile.mockResolvedValueOnce({ Key: 'posts/first.jpg' }).mockResolvedValueOnce(null);
    await expect(controller.create({} as any, [jpeg, jpeg], user)).rejects.toBeInstanceOf(BadRequestException);
    expect(s3.deleteOne).toHaveBeenCalledWith('posts/first.jpg', process.env.AWS_DEFAULT_S3_BUCKET);
    expect(posts.create).not.toHaveBeenCalled();
  });

  it('answers 404 when deleting a post the caller does not own, touching nothing', async () => {
    posts.deleteOwnPost.mockResolvedValue(null);
    await expect(controller.remove('507f1f77bcf86cd799439099', user)).rejects.toBeInstanceOf(NotFoundException);
    expect(s3.deleteOne).not.toHaveBeenCalled();
  });

  it('returns the confirmed like state', async () => {
    await expect(controller.likePost('p1', user)).resolves.toMatchObject({ data: { liked: true, likeCount: 1 } });
  });
});
