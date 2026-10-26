import { PhotosService } from '../photos/photos.service';
import { blockContext } from '../user-blocks/block-context';

describe('Public profile response privacy', () => {
  const owner = '507f1f77bcf86cd799439011', viewer = '507f1f77bcf86cd799439012';
  it('strips private fields from nested populated users but preserves self and authorized staff views', async () => {
    const service = new PhotosService({} as any, {} as any);
    jest.spyOn(service as any, 'responseContext').mockResolvedValue({
      ownerId: owner, resourceId: owner, resourceType: 'profile',
    });
    const source = { _id: owner, displayname: 'Public', bio: 'Hello', phoneNumber: 'private',
      username: 'private@example.test', roles: ['root'], loginAttempts: 2, isBlocked: false,
      password: 'hash', passwordResetToken: 'secret', canEditProfile: true };
    const result = await service.present({ users: [source] }, viewer);
    expect(result.users[0]).toEqual({ _id: owner, displayname: 'Public', bio: 'Hello' });
    const self = await service.present(source, owner);
    expect(self.username).toBe(source.username);
    expect(self.roles).toEqual(['root']);
    expect(self.password).toBeUndefined();
    expect(self.passwordResetToken).toBeUndefined();
    const staff = await blockContext.run({ bypass: true }, () => service.present(source, viewer));
    expect(staff.roles).toEqual(['root']);
    expect(staff.password).toBeUndefined();
  });
});
