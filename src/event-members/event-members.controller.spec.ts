import { Test, TestingModule } from '@nestjs/testing';
import { EventMembersController } from './event-members.controller';
import { EventMembersService } from './event-members.service';
import { EventRequestStatus } from '../common/schemas/event-members.schema';

describe('EventMembersController', () => {
  let controller: EventMembersController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [EventMembersController],
      providers: [EventMembersService],
    }).useMocker(() => ({})).compile();

    controller = module.get<EventMembersController>(EventMembersController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
  it('binds joins to the authenticated actor and ignores injected acceptance', async () => {
    const sendJoinRequest = jest.fn().mockResolvedValue({});
    const route = new EventMembersController({ sendJoinRequest } as any);
    await route.sendJoinRequest({ event: 'event', user: 'victim', requestStatus: EventRequestStatus.ACCEPTED }, { id: 'actual-member' } as any);
    expect(sendJoinRequest).toHaveBeenCalledWith(expect.objectContaining({ user: 'actual-member', requestStatus: EventRequestStatus.PENDING }));
  });
});
