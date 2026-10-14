import { ChatGateway } from './chats.gateway';

const userId = '507f1f77bcf86cd799439011';
const receiverId = '507f1f77bcf86cd799439012';

function socket(overrides: any = {}) {
  return {
    id: 'socket-1',
    data: {},
    handshake: { auth: { token: 'valid-token' } },
    join: jest.fn(),
    emit: jest.fn(),
    disconnect: jest.fn(),
    ...overrides,
  } as any;
}

function makeGateway() {
  const chatService: any = {
    getUserById: jest.fn().mockResolvedValue({ _id: userId, roles: [] }),
    updateUserStatus: jest.fn().mockResolvedValue(undefined),
    assertCanSendDirect: jest.fn().mockResolvedValue(true),
    assertGroupMember: jest.fn().mockResolvedValue(true),
    saveTextMessage: jest.fn().mockImplementation(async (data) => ({ _id: 'm1', ...data })),
    getUnreadMessageCount: jest.fn().mockResolvedValue([]),
    getChatHistory: jest.fn().mockResolvedValue([]),
    getChatGroupHistory: jest.fn().mockResolvedValue([]),
    markMessagesAsRead: jest.fn().mockResolvedValue([]),
    updateMessage: jest.fn(),
    deleteMessage: jest.fn(),
  };
  const jwt: any = { verifyAsync: jest.fn().mockResolvedValue({ sub: userId }) };
  const gateway = new ChatGateway(chatService, jwt);
  gateway.server = {
    to: jest.fn().mockReturnValue({ emit: jest.fn() }),
    emit: jest.fn(),
  } as any;
  return { gateway, chatService, jwt };
}

describe('ChatGateway authentication and identity', () => {
  it('authenticates the socket JWT and stores the verified identity', async () => {
    const { gateway } = makeGateway();
    const client = socket();
    await gateway.handleConnection(client);
    expect(client.data.userId).toBe(userId);
    expect(client.join).toHaveBeenCalledWith(`user:${userId}`);
  });

  it('rejects an expired or invalid socket JWT', async () => {
    const { gateway, jwt } = makeGateway();
    jwt.verifyAsync.mockRejectedValue(new Error('jwt expired'));
    const client = socket();
    await gateway.handleConnection(client);
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(client.data.userId).toBeUndefined();
  });

  it('ignores a forged sender id and uses client.data.userId', async () => {
    const { gateway, chatService } = makeGateway();
    const client = socket({ data: { userId } });
    await gateway.handleSendMessage(
      { sender: '507f1f77bcf86cd799439099', receiver: receiverId, message: 'hello' } as any,
      client,
    );
    expect(chatService.saveTextMessage).toHaveBeenCalledWith(expect.objectContaining({
      sender: userId,
      receiver: receiverId,
    }));
  });

  it('authorizes group membership before joining a room', async () => {
    const { gateway, chatService } = makeGateway();
    const client = socket({ data: { userId } });
    await gateway.handleJoinGroup(client, receiverId);
    expect(chatService.assertGroupMember).toHaveBeenCalledWith(userId, receiverId);
    expect(client.join).toHaveBeenCalledWith(`group:${receiverId}`);
  });
});
