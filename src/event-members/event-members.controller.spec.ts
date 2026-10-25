import { Test, TestingModule } from '@nestjs/testing';
import { EventMembersController } from './event-members.controller';
import { EventMembersService } from './event-members.service';

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
});
