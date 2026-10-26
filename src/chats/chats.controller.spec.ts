import { BadRequestException } from '@nestjs/common';
import { ChatsController } from './chats.controller';
import { ChatService } from './chats.service';
import { ChatGateway } from './chats.gateway';

describe('Chat HTTP history fallback', () => {
  const service = { getChatHistory: jest.fn(), getChatGroupHistory: jest.fn() };
  const controller = new ChatsController(service as unknown as ChatService, {} as ChatGateway);
  beforeEach(() => jest.clearAllMocks());

  it('loads direct history with the authenticated viewer, not a client sender', async () => {
    service.getChatHistory.mockResolvedValue([{ _id: 'message' }]);
    const result = await controller.history({ id: 'viewer' } as never, { receiver: 'peer' });
    expect(service.getChatHistory).toHaveBeenCalledWith('viewer', 'peer');
    expect(result.data).toEqual([{ _id: 'message' }]);
  });

  it('loads groups through the existing membership check', async () => {
    service.getChatGroupHistory.mockResolvedValue([]);
    expect((await controller.history({ id: 'viewer' } as never, { groupId: 'group' })).data).toEqual([]);
    expect(service.getChatGroupHistory).toHaveBeenCalledWith('viewer', 'group');
  });

  it.each([{}, { receiver: 'peer', groupId: 'group' }])('rejects an ambiguous target %j', async (query) => {
    await expect(controller.history({ id: 'viewer' } as never, query)).rejects.toBeInstanceOf(BadRequestException);
    expect(service.getChatHistory).not.toHaveBeenCalled();
    expect(service.getChatGroupHistory).not.toHaveBeenCalled();
  });
});
