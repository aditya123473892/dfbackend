import { ChatGateway } from './chats.gateway';
import { Subject } from 'rxjs';
import { unblockedPolicy } from '../user-blocks/block.fixture';

const userId = '507f1f77bcf86cd799439011';
const receiverId = '507f1f77bcf86cd799439012';

function socket(overrides: any = {}) {
  return {
    id: 'socket-1',
    data: {},
    handshake: { auth: { token: 'valid-token' } },
    join: jest.fn(),
    use: jest.fn(),
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
    saveTextMessage: jest
      .fn()
      .mockImplementation(async (data) => ({ _id: 'm1', ...data })),
    getUnreadMessageCount: jest.fn().mockResolvedValue([]),
    getChatHistory: jest.fn().mockResolvedValue([]),
    getChatGroupHistory: jest.fn().mockResolvedValue([]),
    markMessagesAsRead: jest.fn().mockResolvedValue([]),
    updateMessage: jest.fn(),
    deleteMessage: jest.fn(),
  };
  const jwt: any = {
    verifyAsync: jest.fn().mockResolvedValue({ sub: userId }),
  };
  const photos: any = {
    assertActiveAccount: jest.fn().mockResolvedValue(undefined),
    accountDeletion$: new Subject<string>(),
  };
  const gateway = new ChatGateway(chatService, jwt, photos, unblockedPolicy());
  gateway.server = {
    to: jest.fn().mockReturnValue({ emit: jest.fn() }),
    emit: jest.fn(),
    in: jest.fn().mockReturnValue({ disconnectSockets: jest.fn() }),
    use: jest.fn(),
  } as any;
  return { gateway, chatService, jwt, photos };
}

describe('ChatGateway authentication and identity', () => {
  it('rejects an account disabled after its JWT was issued', async () => {
    const { gateway, photos } = makeGateway();
    photos.assertActiveAccount.mockRejectedValue(
      new Error('Account unavailable'),
    );
    const client = socket();
    await gateway.handleConnection(client);
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(client.data.userId).toBeUndefined();
  });

  it('rechecks current account state on packets from an already-connected socket', async () => {
    const { gateway, photos } = makeGateway();
    const client = socket();
    await gateway.handleConnection(client);
    photos.assertActiveAccount.mockRejectedValue(
      new Error('Account unavailable'),
    );
    const next = jest.fn();
    await client.use.mock.calls[0][0]([], next);
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(next).not.toHaveBeenCalled();
  });

  it('disconnects the account room when account deletion is requested', () => {
    const { gateway, photos } = makeGateway();
    gateway.afterInit(gateway.server);
    photos.accountDeletion$.next(userId);
    expect(gateway.server.in).toHaveBeenCalledWith(`user:${userId}`);
    expect(
      gateway.server.in(`user:${userId}`).disconnectSockets,
    ).toHaveBeenCalledWith(true);
  });

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
      {
        sender: '507f1f77bcf86cd799439099',
        receiver: receiverId,
        message: 'hello',
      } as any,
      client,
    );
    expect(chatService.saveTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sender: userId,
        receiver: receiverId,
      }),
    );
  });

  it('authorizes group membership before joining a room', async () => {
    const { gateway, chatService } = makeGateway();
    const client = socket({ data: { userId } });
    await gateway.handleJoinGroup(client, receiverId);
    expect(chatService.assertGroupMember).toHaveBeenCalledWith(
      userId,
      receiverId,
    );
    expect(client.join).toHaveBeenCalledWith(`group:${receiverId}`);
  });
});
