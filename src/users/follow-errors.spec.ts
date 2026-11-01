import { BadRequestException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { UsersController } from './users.controller';
import { FollowStatus } from '../common/schemas/follow.schema';

describe('Follow API error handling', () => {
  const actor = { id:'507f1f77bcf86cd799439011' } as any;
  const target = '507f1f77bcf86cd799439012';
  const operations = [
    { method:'sendFollowRequest', invoke:(controller: UsersController) => controller.sendFollowRequest({ following:target } as any,actor) },
    { method:'approveFollowRequest', invoke:(controller: UsersController) => controller.approveFollowRequest(target,{ status:FollowStatus.ACCEPTED },actor) },
    { method:'unfollowUser', invoke:(controller: UsersController) => controller.unfollowUser(target,actor) },
    { method:'cancelFollowRequest', invoke:(controller: UsersController) => controller.cancelFollow(target,actor) },
  ];
  it.each(operations)('$method reports infrastructure failures as a safe retryable 503', async ({ method,invoke }) => {
    const service = { [method]:jest.fn().mockRejectedValue(new Error('mongo://password@private-host')) };
    const controller = new UsersController(service as any,null,null,null);
    await expect(invoke(controller)).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(invoke(controller)).rejects.toMatchObject({ message:'Follow status could not be saved. Try again.' });
  });
  it.each(operations)('$method retains validation, missing-resource and authorization errors', async ({ method,invoke }) => {
    for (const error of [new BadRequestException('Invalid request'),new NotFoundException(),new ForbiddenException()]) {
      const controller = new UsersController({ [method]:jest.fn().mockRejectedValue(error) } as any,null,null,null);
      await expect(invoke(controller)).rejects.toBe(error);
    }
  });
});
