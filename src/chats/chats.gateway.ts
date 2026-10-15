import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import { ObjectId } from 'mongodb';
import { ChatService } from './chats.service';
import { ERole } from 'src/common/enums';

function socketCorsOrigin(
  origin: string,
  callback: (error: Error, allow?: boolean) => void,
) {
  const configured = (
    process.env.FRONTEND_ORIGIN ||
    process.env.PUBLIC_SITE_DOMAIN ||
    'http://localhost:3000'
  )
    .split(',')
    .map((value) => value.trim().replace(/\/$/, ''))
    .filter(Boolean);
  if (!origin || configured.includes(origin.replace(/\/$/, ''))) {
    return callback(null, true);
  }
  return callback(new Error('Origin is not allowed'));
}

@WebSocketGateway({
  cors: { origin: socketCorsOrigin, credentials: true },
})
export class ChatGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly userSockets = new Map<string, Set<string>>();
  private readonly onlineAdmins = new Set<string>();

  constructor(
    private readonly chatService: ChatService,
    private readonly jwtService: JwtService,
  ) {}

  afterInit(server: Server) {
    server.use(async (client, next) => {
      try {
        await this.authenticateClient(client);
        next();
      } catch (_error) {
        next(new Error('Unauthorized socket connection'));
      }
    });
  }

  async handleConnection(client: Socket) {
    try {
      if (!client.data.userId) await this.authenticateClient(client);
      const userId = client.data.userId;
      const user = await this.chatService.getUserById(userId);
      client.join(`user:${userId}`);
      // Subscribe to every group up front so group messages arrive even before
      // (or without) a joinGroup call, including after reconnects.
      const groupIds = await this.chatService.getGroupIdsForUser(userId);
      if (groupIds.length) client.join(groupIds.map((groupId) => `group:${groupId}`));
      const sockets = this.userSockets.get(userId) || new Set<string>();
      sockets.add(client.id);
      this.userSockets.set(userId, sockets);
      await this.chatService.updateUserStatus(userId, true);

      if (user.roles?.includes(ERole.ADMIN)) {
        this.onlineAdmins.add(userId);
        this.server.emit('adminOnline', { adminId: userId });
      }
    } catch (_error) {
      client.emit('authError', { message: 'Unauthorized socket connection' });
      client.disconnect(true);
    }
  }

  async handleDisconnect(client: Socket) {
    const userId = client.data?.userId;
    if (!userId) return;
    const sockets = this.userSockets.get(userId);
    sockets?.delete(client.id);
    if (sockets?.size) return;
    this.userSockets.delete(userId);
    await this.chatService.updateUserStatus(userId, false);
    const user = await this.chatService.getUserById(userId);
    if (user?.roles?.includes(ERole.ADMIN) && this.onlineAdmins.delete(userId)) {
      this.server.emit('adminOffline', { adminId: userId });
    }
  }

  @SubscribeMessage('setUserRoom')
  handleSetUserRoom(@ConnectedSocket() client: Socket) {
    // Kept as a compatibility no-op. The verified user room is joined during
    // connection; clients cannot choose arbitrary rooms.
    return { userId: client.data.userId };
  }

  @SubscribeMessage('joinGroup')
  async handleJoinGroup(
    @ConnectedSocket() client: Socket,
    @MessageBody() groupId: string,
  ) {
    try {
      await this.chatService.assertGroupMember(client.data.userId, groupId);
      await client.join(`group:${groupId}`);
      return { groupId };
    } catch (error) {
      this.emitError(client, error);
    }
  }

  @SubscribeMessage('sendMessage')
  async handleSendMessage(
    @MessageBody() data: { receiver: string; message?: string; media?: unknown[]; type?: string; clientId?: string },
    @ConnectedSocket() client: Socket,
  ) {
    try {
      if (data.media?.length) throw new Error('Attachments must use the authenticated upload endpoint');
      await this.chatService.assertCanSendDirect(client.data.userId, data.receiver);
      const saved = await this.chatService.saveTextMessage({
        sender: client.data.userId,
        receiver: data.receiver,
        message: data.message,
        type: data.type,
        clientId: data.clientId,
      });
      this.broadcastSavedMessage(saved);
      const unreadData = await this.chatService.getUnreadMessageCount(data.receiver);
      this.server.to(`user:${data.receiver}`).emit('unreadData', unreadData);
      return saved;
    } catch (error) {
      this.emitError(client, error);
    }
  }

  @SubscribeMessage('getChatHistory')
  async handleGetChatHistory(
    @MessageBody() data: { user1?: string; user2: string; limit?: number; before?: string },
    @ConnectedSocket() client: Socket,
  ) {
    try {
      const history = await this.chatService.getChatHistory(client.data.userId, data?.user2, {
        limit: data?.limit,
        before: data?.before,
      });
      client.emit('chatHistory', history);
    } catch (error) {
      this.emitError(client, error);
    }
  }

  @SubscribeMessage('markAsRead')
  async handleMarkAsRead(
    @MessageBody() data: { user1?: string; user2: string },
    @ConnectedSocket() client: Socket,
  ) {
    try {
      const userId = client.data.userId;
      const unread = await this.chatService.markMessagesAsRead(userId, data.user2);
      client.emit('unreadMessageCount', unread);
      // Keep the reader's other devices in sync.
      client.to(`user:${userId}`).emit('unreadMessageCount', unread);
      this.server.to(`user:${data.user2}`).emit('messagesRead', { userId });
    } catch (error) {
      this.emitError(client, error);
    }
  }

  @SubscribeMessage('markGroupAsRead')
  async handleMarkGroupAsRead(
    @MessageBody() data: { groupId: string },
    @ConnectedSocket() client: Socket,
  ) {
    try {
      const result = await this.chatService.markGroupAsRead(client.data.userId, data?.groupId);
      client.to(`user:${client.data.userId}`).emit('groupRead', result);
      return result;
    } catch (error) {
      this.emitError(client, error);
    }
  }

  @SubscribeMessage('getUnreadCount')
  async handleGetUnreadCount(@ConnectedSocket() client: Socket) {
    client.emit('unreadMessageCount', await this.chatService.getUnreadMessageCount(client.data.userId));
  }

  /**
   * Ephemeral and not persisted. Direct: `{ receiver }`. Group: `{ groupId }`,
   * relayed only from a socket already in that group's room (membership was
   * verified when it joined). `isTyping: false` clears the indicator.
   */
  @SubscribeMessage('typing')
  handleTyping(
    @MessageBody() data: { receiver?: string; groupId?: string; isTyping?: boolean },
    @ConnectedSocket() client: Socket,
  ) {
    const sender = client.data.userId;
    const isTyping = data?.isTyping !== false;
    if (data?.groupId) {
      const room = `group:${data.groupId}`;
      if (ObjectId.isValid(data.groupId) && client.rooms?.has(room)) {
        client.to(room).emit('typing', { sender, groupId: data.groupId, isTyping });
      }
      return;
    }
    if (!ObjectId.isValid(data?.receiver) || data.receiver === sender) return;
    this.server.to(`user:${data.receiver}`).emit('typing', { sender, isTyping });
  }

  @SubscribeMessage('updateMessage')
  async handleUpdateMessage(
    @MessageBody() data: { messageId: string; userId?: string; newMessage: string },
    @ConnectedSocket() client: Socket,
  ) {
    try {
      const updated = await this.chatService.updateMessage(data.messageId, client.data.userId, data.newMessage);
      this.broadcastSavedMessage(updated, 'messageUpdated');
      return updated;
    } catch (error) {
      this.emitError(client, error);
    }
  }

  @SubscribeMessage('deleteMessage')
  async handleDeleteMessage(
    @MessageBody() data: { messageId: string; userId?: string },
    @ConnectedSocket() client: Socket,
  ) {
    try {
      const deleted = await this.chatService.deleteMessage(data.messageId, client.data.userId);
      this.broadcastSavedMessage(
        { ...deleted, messageId: data.messageId },
        'messageDeleted',
      );
    } catch (error) {
      this.emitError(client, error);
    }
  }

  @SubscribeMessage('sendGroupMessage')
  async handleSendGroupMessage(
    @MessageBody() data: { sender?: string; groupId: string; message?: string; media?: unknown[]; clientId?: string },
    @ConnectedSocket() client: Socket,
  ) {
    try {
      if (data.media?.length) throw new Error('Attachments must use the authenticated upload endpoint');
      await this.chatService.assertGroupMember(client.data.userId, data.groupId);
      const saved = await this.chatService.saveTextMessage({
        sender: client.data.userId,
        groupId: data.groupId,
        message: data.message,
        type: 'group',
        clientId: data.clientId,
      });
      this.broadcastSavedMessage(saved);
      return saved;
    } catch (error) {
      this.emitError(client, error);
    }
  }

  @SubscribeMessage('getGroupChatHistory')
  async handleGetGroupChatHistory(
    @MessageBody() data: { groupId: string; limit?: number; before?: string },
    @ConnectedSocket() client: Socket,
  ) {
    try {
      const history = await this.chatService.getChatGroupHistory(client.data.userId, data?.groupId, {
        limit: data?.limit,
        before: data?.before,
      });
      client.emit('groupChatHistory', history);
    } catch (error) {
      this.emitError(client, error);
    }
  }

  broadcastSavedMessage(message: any, event?: string) {
    if (!this.server) return;
    const senderId = String(message.sender?._id || message.sender);
    if (message.groupId) {
      this.server.to(`group:${message.groupId}`).emit(event || 'receiveGroupMessage', message);
      return;
    }
    // One emit to both rooms: Socket.IO delivers once per socket.
    this.server
      .to([`user:${senderId}`, `user:${message.receiver?._id || message.receiver}`])
      .emit(event || 'receiveMessage', message);
  }

  /**
   * Applies a membership change to live sockets: added members start receiving
   * the group's events immediately, removed members stop immediately.
   */
  syncGroupMembership(group: any, added: string[] = [], removed: string[] = []) {
    if (!this.server) return;
    const groupId = String(group._id);
    const room = `group:${groupId}`;
    for (const userId of added) this.server.in(`user:${userId}`).socketsJoin(room);
    for (const userId of removed) {
      this.server.in(`user:${userId}`).socketsLeave(room);
      this.server.to(`user:${userId}`).emit('groupRemoved', { groupId });
    }
    this.server.to(room).emit('groupUpdated', this.groupSummary(group));
  }

  /** Notifies members, then detaches every socket from a deleted group. */
  broadcastGroupDeleted(groupId: string) {
    if (!this.server) return;
    const room = `group:${groupId}`;
    this.server.to(room).emit('groupRemoved', { groupId, deleted: true });
    this.server.in(room).socketsLeave(room);
  }

  private groupSummary(group: any) {
    return {
      _id: String(group._id),
      name: group.name,
      description: group.description,
      groupIcon: group.groupIcon,
      admin: String(group.admin),
      memberCount: group.members?.length || 0,
      updatedAt: group.updatedAt,
    };
  }

  private emitError(client: Socket, error: any) {
    client.emit('error', {
      statusCode: error?.getStatus?.() || 400,
      message: error?.message || 'Chat operation failed',
    });
  }

  private async authenticateClient(client: Socket) {
    const supplied = client.handshake.auth?.token;
    const token = typeof supplied === 'string'
      ? supplied.replace(/^Bearer\s+/i, '')
      : '';
    if (!token) throw new Error('Missing authentication token');
    const payload = await this.jwtService.verifyAsync(token);
    const userId = String(payload?.sub || '');
    if (!ObjectId.isValid(userId)) throw new Error('Invalid authentication token');
    const user = await this.chatService.getUserById(userId);
    if (!user) throw new Error('Invalid authentication token');
    client.data.userId = userId;
  }
}
