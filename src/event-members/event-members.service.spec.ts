import { Test, TestingModule } from '@nestjs/testing';
import { EventMembersService } from './event-members.service';

describe('EventMembersService', () => {
  let service: EventMembersService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [EventMembersService],
    }).compile();

    service = module.get<EventMembersService>(EventMembersService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
