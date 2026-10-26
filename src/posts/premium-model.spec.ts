import { applicationValidationPipe } from '../common/validation';
import { PhotoPostDto, EditPhotoPostDto } from './dto/photo-post.dto';
import { AdminPhotoPostDto, AdminCreatePhotoPostDto } from './dto/admin-photo-post.dto';
import { CreateUserDto } from '../users/dtos/create-user.dto';
import { UpdateUserDto } from '../users/dtos/update-user.dto';
import { SelfProfileDto } from '../users/dtos/self-profile.dto';
import { UpdateUserProfileDto } from '../users/dtos/update-user-profile.dto';

describe('Global premium input validation', () => {
  const pipe = applicationValidationPipe();
  it.each([CreateUserDto, UpdateUserDto, SelfProfileDto, UpdateUserProfileDto,
    PhotoPostDto, EditPhotoPostDto, AdminPhotoPostDto, AdminCreatePhotoPostDto])(
    '%p rejects client premiumUntil', async (metatype) => {
      await expect(pipe.transform({ premiumUntil: '2099-01-01' }, { type: 'body', metatype }))
        .rejects.toMatchObject({ response: { message: expect.arrayContaining(['property premiumUntil should not exist']) } });
    },
  );
  it('allows an author to choose premium, but rejects unknown tiers', async () => {
    await expect(pipe.transform({ contentVisibility: 'premium' }, { type: 'body', metatype: EditPhotoPostDto }))
      .resolves.toMatchObject({ contentVisibility: 'premium' });
    await expect(pipe.transform({ contentVisibility: 'admin' }, { type: 'body', metatype: EditPhotoPostDto })).rejects.toThrow();
  });
});
