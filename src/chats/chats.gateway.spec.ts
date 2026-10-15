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
    getGroupIdsForUser: jest.fn().mockResolvedValue([]),
    markGroupAsRead: jest.fn().mockImplementation(async (_user, groupId) => ({ groupId, unreadCount: 0 })),
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

describe('ChatGateway realtime delivery', () => {
  const groupA = '507f1f77bcf86cd799439021';
  const groupB = '507f1f77bcf86cd799439022';

  function recordingServer() {
    const emits: { rooms: unknown; event: string; payload: unknown }[] = [];
    const joins: { room: string; target: string; action: string }[] = [];
    const server: any = {
      to: jest.fn((rooms) => ({ emit: (event, payload) => emits.push({ rooms, event, payload }) })),
      in: jest.fn((target) => ({
        socketsJoin: (room) => joins.push({ target, room, action: 'join' }),
        socketsLeave: (room) => joins.push({ target, room, action: 'leave' }),
      })),
      emit: jest.fn(),
    };
    return { server, emits, joins };
  }

  it('joins every group room of the user on connect, so group events survive reconnects', async () => {
    const { gateway, chatService } = makeGateway();
    chatService.getGroupIdsForUser.mockResolvedValue([groupA, groupB]);
    const client = socket();
    await gateway.handleConnection(client);
    expect(client.join).toHaveBeenCalledWith([`group:${groupA}`, `group:${groupB}`]);
  });

  it('relays group typing only from sockets in that group room, excluding the sender', () => {
    const { gateway } = makeGateway();
    const roomEmit = jest.fn();
    const member = socket({ data: { userId }, rooms: new Set([`group:${groupA}`]), to: jest.fn(() => ({ emit: roomEmit })) });
    gateway.handleTyping({ groupId: groupA }, member);
    expect(member.to).toHaveBeenCalledWith(`group:${groupA}`);
    expect(roomEmit).toHaveBeenCalledWith('typing', { sender: userId, groupId: groupA, isTyping: true });

    const outsider = socket({ data: { userId }, rooms: new Set(), to: jest.fn(() => ({ emit: roomEmit })) });
    gateway.handleTyping({ groupId: groupB }, outsider);
    expect(outsider.to).not.toHaveBeenCalled();
  });

  it('relays direct typing to the receiver and ignores invalid or self targets', () => {
    const { gateway } = makeGateway();
    const { server, emits } = recordingServer();
    gateway.server = server;
    const client = socket({ data: { userId } });
    gateway.handleTyping({ receiver: receiverId, isTyping: false }, client);
    gateway.handleTyping({ receiver: 'not-an-id' }, client);
    gateway.handleTyping({ receiver: userId }, client);
    expect(emits).toEqual([{ rooms: `user:${receiverId}`, event: 'typing', payload: { sender: userId, isTyping: false } }]);
  });

  it('sends direct messages once to both participants', () => {
    const { gateway } = makeGateway();
    const { server, emits } = recordingServer();
    gateway.server = server;
    gateway.broadcastSavedMessage({ _id: 'm1', sender: userId, receiver: receiverId });
    expect(emits).toEqual([
      { rooms: [`user:${userId}`, `user:${receiverId}`], event: 'receiveMessage', payload: expect.anything() },
    ]);
  });

  it('moves live sockets in and out of a group room when membership changes', () => {
    const { gateway } = makeGateway();
    const { server, emits, joins } = recordingServer();
    gateway.server = server;
    gateway.syncGroupMembership({ _id: groupA, name: 'G', admin: userId, members: [userId, receiverId] }, [receiverId], ['507f1f77bcf86cd799439099']);
    expect(joins).toEqual([
      { target: `user:${receiverId}`, room: `group:${groupA}`, action: 'join' },
      { target: 'user:507f1f77bcf86cd799439099', room: `group:${groupA}`, action: 'leave' },
    ]);
    expect(emits).toEqual(expect.arrayContaining([
      { rooms: 'user:507f1f77bcf86cd799439099', event: 'groupRemoved', payload: { groupId: groupA } },
      { rooms: `group:${groupA}`, event: 'groupUpdated', payload: expect.objectContaining({ _id: groupA, memberCount: 2 }) },
    ]));
  });

  it('acknowledges group reads and syncs the reader\'s other devices', async () => {
    const { gateway, chatService } = makeGateway();
    const ownRoomEmit = jest.fn();
    const client = socket({ data: { userId }, to: jest.fn(() => ({ emit: ownRoomEmit })) });
    await expect(gateway.handleMarkGroupAsRead({ groupId: groupA }, client)).resolves.toEqual({ groupId: groupA, unreadCount: 0 });
    expect(chatService.markGroupAsRead).toHaveBeenCalledWith(userId, groupA);
    expect(client.to).toHaveBeenCalledWith(`user:${userId}`);
    expect(ownRoomEmit).toHaveBeenCalledWith('groupRead', { groupId: groupA, unreadCount: 0 });
  });

  it('passes the client idempotency key through socket sends', async () => {
    const { gateway, chatService } = makeGateway();
    const { server } = recordingServer();
    gateway.server = server;
    await gateway.handleSendMessage({ receiver: receiverId, message: 'hi', clientId: 'abcdefgh1' }, socket({ data: { userId } }));
    expect(chatService.saveTextMessage).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'abcdefgh1' }));
  });
});
