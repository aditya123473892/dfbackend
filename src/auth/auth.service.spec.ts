import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';

describe('Authentication failure classification', () => {
  function harness(user: any) {
    const users: any = {
      findOneWithPassword: jest.fn().mockResolvedValue(user),
    };
    const service = new AuthService(users, {} as any);
    return { service, users };
  }

  it('rejects a wrong password as 401 rather than a server error', async () => {
    const { service } = harness({ password: 'stored-hash' });
    jest.spyOn(service, 'comparePassword').mockResolvedValue(false);
    await expect(
      service.validateUser('seed@example.test', 'incorrect'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an unknown account with the same 401 response', async () => {
    const { service } = harness(null);
    await expect(
      service.validateUser('unknown@example.test', 'incorrect'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('accepts a matching password and strips the hash from the result', async () => {
    const { service } = harness({
      username: 'seed@example.test',
      password: 'stored-hash',
    });
    jest.spyOn(service, 'comparePassword').mockResolvedValue(true);
    await expect(
      service.validateUser('seed@example.test', 'correct'),
    ).resolves.toMatchObject({ password: '' });
  });

  it('preserves database outages as server failures', async () => {
    const { service, users } = harness(null);
    users.findOneWithPassword.mockRejectedValue(
      new Error('Database unavailable'),
    );
    await expect(
      service.validateUser('seed@example.test', 'correct'),
    ).rejects.toThrow('Database unavailable');
  });
});
