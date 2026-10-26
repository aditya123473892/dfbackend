import { createConnection, Connection, Schema, Types } from 'mongoose';
import { randomUUID } from 'crypto';
import { BlockService } from './block.service';
import { blockContext, blockQueryPlugin, blockedIds } from './block-context';
import { blockIndexes } from './block-indexes';
import { UsersService } from '../users/users.service';
import { UsersController } from '../users/users.controller';
import { ChatService } from '../chats/chats.service';
import { ChatGateway } from '../chats/chats.gateway';
import { PhotosService } from '../photos/photos.service';
import { groupServiceFor } from './block.fixture';
import { NotificationService } from '../notification/notification.service';
import { UserBlocksController } from './user-blocks.controller';
import { FollowStatus } from '../common/schemas/follow.schema';
import { ChatMessageSchema } from '../common/schemas/chats.schema';

const integration = process.env.TEST_MONGO_URI ? describe : describe.skip;
integration('User-to-user block boundaries with real MongoDB', () => {
  let db: Connection, blocks: BlockService;
  const name = 'darkfantasy_blocks_test_' + randomUUID().replace(/-/g, '');
  const a = new Types.ObjectId(),
    b = new Types.ObjectId(),
    c = new Types.ObjectId(),
    group = new Types.ObjectId();
  const model: Record<string, any> = {};
  const as = <T>(viewer: Types.ObjectId, fn: () => T) =>
    blockContext.run({ viewerId: String(viewer) }, fn);
  const users = () =>
    new UsersService(
      model.Users,
      model.UserEdits,
      model.follows,
      model.Posts,
      model.PostRequest,
      model.UserBookMark,
      model.ChatMessages,
      blocks,
    );
  const chats = (photos: any = {}) =>
    new ChatService(
      model.ChatMessages,
      model.Users,
      model.Groups,
      { create: async () => ({}) } as any,
      {} as any,
      photos,
      blocks,
    );
  beforeAll(async () => {
    db = await createConnection(process.env.TEST_MONGO_URI, {
      dbName: name,
    }).asPromise();
    db.plugin(blockQueryPlugin);
    for (const collection of [
      'Users',
      'Posts',
      'Comments',
      'Likes',
      'Events',
      'EventMembers',
      'follows',
      'PostRequest',
      'UserBookMark',
      'PostBookMark',
      'Notifications',
      'UserEdits',
      'Groups',
    ]) {
      const schema = new Schema(
        {
          user: Schema.Types.ObjectId,
          creator: Schema.Types.ObjectId,
          post: Schema.Types.ObjectId,
          event: Schema.Types.ObjectId,
          postId: Schema.Types.ObjectId,
          userId: Schema.Types.ObjectId,
          requestedUserId: Schema.Types.ObjectId,
          bookMarkUser: Schema.Types.ObjectId,
          follower: Schema.Types.ObjectId,
          following: Schema.Types.ObjectId,
          sender: Schema.Types.ObjectId,
          receiver: Schema.Types.ObjectId,
          members: [Schema.Types.ObjectId],
        },
        { collection, strict: false },
      );
      model[collection] = db.model(collection, schema);
    }
    model.ChatMessages = db.model('ChatMessages', ChatMessageSchema.clone());
    blocks = new BlockService(db);
    await blockIndexes(db, true, () => {});
  });
  beforeEach(async () => {
    for (const collection of await db.db.collections())
      await collection.deleteMany({});
    await db.db.collection('Users').insertMany([
      { _id: a, displayname: 'A', isBlocked: false },
      { _id: b, displayname: 'B', roles: ['admin'], isBlocked: false },
      { _id: c, displayname: 'C' },
    ]);
    await db.db
      .collection('Groups')
      .insertOne({ _id: group, admin: a, members: [a, b, c] });
  });
  afterAll(async () => {
    if (db) {
      if (db.name === name) await db.dropDatabase();
      await db.close();
    }
  });

  it('is idempotent under concurrent requests, permits staff targets and never writes account blocking', async () => {
    await Promise.all(
      Array.from({ length: 8 }, () => blocks.block(String(a), String(b))),
    );
    expect(await db.db.collection('UserBlocks').countDocuments({})).toBe(1);
    expect(
      (await db.db.collection('Users').findOne({ _id: b })).isBlocked,
    ).toBe(false);
    expect(await blocks.isBlockedEitherWay(String(b), String(a))).toBe(true);
    await expect(blocks.block(String(a), String(a))).rejects.toThrow(
      'yourself',
    );
  });
  it('enforces the 1,000 cap across simultaneous transactions without losing existing blocks', async () => {
    await db.db.collection<any>('UserBlocks').insertMany(
      Array.from({ length: 999 }, () => ({
        _id: randomUUID(),
        blockerId: a,
        blockedId: new Types.ObjectId(),
        createdAt: new Date(),
      })),
    );
    const result = await Promise.allSettled([
      blocks.block(String(a), String(b)),
      blocks.block(String(a), String(c)),
    ]);
    expect(result.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    expect(
      await db.db.collection('UserBlocks').countDocuments({ blockerId: a }),
    ).toBe(1000);
    const winner = result[0].status === 'fulfilled' ? b : c;
    await expect(blocks.block(String(a), String(winner))).resolves.toEqual({
      blocked: true,
    });
  });
  it('cancels pending requests in both directions but retains accepted relationships and content', async () => {
    await db.db.collection('follows').insertMany([
      { follower: a, following: b, status: 'pending' },
      { follower: b, following: a, status: 'pending' },
      { follower: a, following: b, status: 'accepted' },
    ]);
    await db.db.collection('PostRequest').insertMany([
      { userId: a, requestedUserId: b, status: 'pending' },
      { userId: b, requestedUserId: a, status: 'pending' },
    ]);
    await blocks.block(String(a), String(b));
    expect(
      await db.db.collection('follows').countDocuments({ status: 'pending' }),
    ).toBe(0);
    expect(
      await db.db.collection('follows').countDocuments({ status: 'accepted' }),
    ).toBe(1);
    expect(
      await db.db
        .collection('PostRequest')
        .countDocuments({ status: 'pending' }),
    ).toBe(0);
    await blocks.unblock(String(a), String(b));
    expect(
      await db.db.collection('follows').countDocuments({ status: 'pending' }),
    ).toBe(0);
    expect(await blocks.isBlockedEitherWay(String(a), String(b))).toBe(false);
  });
  it('requires the recipient to approve a pending follow and prevents acceptance after blocking', async () => {
    const row = await db.db
      .collection('follows')
      .insertOne({ follower: a, following: b, status: 'pending' });
    await expect(
      users().approveFollowRequest(
        String(row.insertedId),
        FollowStatus.ACCEPTED,
        String(c),
      ),
    ).rejects.toThrow('not found');
    await expect(
      users().approveFollowRequest(
        String(row.insertedId),
        FollowStatus.PENDING,
        String(b),
      ),
    ).rejects.toThrow('Invalid');
    await blocks.block(String(a), String(b));
    await expect(
      users().approveFollowRequest(
        String(row.insertedId),
        FollowStatus.ACCEPTED,
        String(b),
      ),
    ).rejects.toThrow('not found');
    await expect(
      users().sendFollowRequest(String(b), String(a)),
    ).rejects.toThrow('User not found!');
  });
  it('uses query predicates for both directions, counts, search, directory, profiles, feed, comments, likes and attendees', async () => {
    const postA = new Types.ObjectId(),
      postB = new Types.ObjectId();
    await db.db
      .collection('Posts')
      .insertMany([
        { _id: postA, user: a },
        { _id: postB, user: b },
        { user: c },
      ]);
    for (const collection of ['Comments', 'Likes'])
      await db.db.collection(collection).insertMany([
        { user: a, post: postA },
        { user: b, post: postA },
        { user: c, post: postB },
      ]);
    await db.db
      .collection('Events')
      .insertMany([{ creator: a }, { creator: b }, { creator: c }]);
    await db.db
      .collection('EventMembers')
      .insertMany([{ user: a }, { user: b }, { user: c }]);
    await blocks.block(String(a), String(b));
    for (const [viewer, hidden] of [
      [a, b],
      [b, a],
    ])
      await as(viewer, async () => {
        expect(await model.Users.findById(hidden)).toBeNull();
        expect(
          await model.Users.find({ displayname: /[AB]/ }).countDocuments(),
        ).toBe(1);
        for (const collection of ['Users', 'Posts', 'Events', 'EventMembers']) {
          expect(await model[collection].countDocuments({})).toBe(2);
          expect(await model[collection].find({}).limit(2)).toHaveLength(2);
          expect(
            (await model[collection].aggregate([{ $count: 'n' }]))[0].n,
          ).toBe(2);
        }
      });
    await as(a, async () => {
      expect(await model.Comments.find({})).toHaveLength(1);
      expect(await model.Likes.countDocuments({})).toBe(1);
      const controller = Object.assign(
        Object.create(UsersController.prototype),
        { usersService: users() },
      );
      // A blocked profile and a missing one fail identically.
      await expect(controller.findOne(String(b), { id: String(a) })).rejects.toThrow(
        'User not found!',
      );
      await expect(
        controller.findOne(String(new Types.ObjectId()), { id: String(a) }),
      ).rejects.toThrow('User not found!');
    });
    await blocks.unblock(String(a), String(b));
    await as(a, async () =>
      expect(await model.Users.countDocuments({})).toBe(3),
    );
  });
  it('memoizes only within one request and exempts staff case queries and vault collections', async () => {
    await as(a, async () => {
      expect(await blockedIds(db, String(a))).toEqual([]);
      await blockContext.run({}, () => blocks.block(String(b), String(a)));
      expect(await blockedIds(db, String(a))).toEqual([]);
      expect(await blocks.isBlockedEitherWay(String(a), String(b))).toBe(true);
    });
    await as(a, async () =>
      expect(await blockedIds(db, String(a))).toEqual([String(b)]),
    );
    await blockContext.run({ viewerId: String(a), bypass: true }, async () =>
      expect(await model.Users.findById(b)).not.toBeNull(),
    );
  });
  it('hides direct inbox/history/unread and denies send and media after a block without removing groups', async () => {
    const message = await model.ChatMessages.create({
      sender: a,
      receiver: b,
      message: 'hello',
      media: [
        { storageKey: 'chat/test.jpg', mimetype: 'image/jpeg', checksum: 'ok' },
      ],
    });
    const photos = { accessUrl: jest.fn().mockResolvedValue('signed') };
    const service = chats(photos);
    await service.getMediaAccessUrl(
      String(b),
      String(message._id),
      String(message.media[0]._id),
    );
    await blocks.block(String(a), String(b));
    await expect(
      service.getMediaAccessUrl(
        String(b),
        String(message._id),
        String(message.media[0]._id),
      ),
    ).rejects.toThrow('not found');
    expect(photos.accessUrl).toHaveBeenCalledTimes(1);
    await expect(
      service.saveTextMessage({
        sender: String(b),
        receiver: String(a),
        message: 'denied',
      }),
    ).rejects.toThrow('not found');
    await expect(service.getChatHistory(String(b), String(a))).rejects.toThrow(
      'not found',
    );
    expect(await service.getUnreadMessageCount(String(b))).toHaveLength(0);
    await as(a, async () =>
      expect(await users().getUserChatList(String(a))).toHaveLength(0),
    );
    const grouped = await model.ChatMessages.create({
      sender: b,
      groupId: group,
      message: 'group text',
      media: [
        {
          storageKey: 'chat/group.jpg',
          mimetype: 'image/jpeg',
          checksum: 'ok',
        },
      ],
    });
    expect(
      (await service.getChatGroupHistory(String(a), String(group)))[0],
    ).toMatchObject({ message: '', media: [], blockedSender: true });
    await expect(
      service.getMediaAccessUrl(
        String(a),
        String(grouped._id),
        String(grouped.media[0]._id),
      ),
    ).rejects.toThrow('Media not found');
    expect(
      (await db.db.collection('Groups').findOne({ _id: group })).members,
    ).toHaveLength(3);
    await blocks.unblock(String(a), String(b));
    await expect(
      service.getChatHistory(String(b), String(a)),
    ).resolves.toHaveLength(1);
  });
  it('also excludes legacy string chat participants at the query level and restores them on unblock', async () => {
    await db.db.collection('ChatMessages').insertOne({
      sender: String(b),
      receiver: String(a),
      message: 'legacy',
      isRead: false,
      sentAt: new Date(),
    });
    await blocks.block(String(a), String(b));
    await as(a, async () =>
      expect(await model.ChatMessages.find({})).toHaveLength(0),
    );
    expect(await chats().getUnreadMessageCount(String(a))).toHaveLength(0);
    await blocks.unblock(String(a), String(b));
    expect(await chats().getChatHistory(String(a), String(b))).toHaveLength(1);
  });
  it('keeps reverse-direction blocking after the caller unblocks and removes phone numbers for every group viewer', async () => {
    await blocks.block(String(a), String(b));
    await blocks.block(String(b), String(a));
    await blocks.unblock(String(a), String(b));
    expect(await blocks.isBlockedEitherWay(String(a), String(b))).toBe(true);
    await db.db
      .collection('Users')
      .updateMany({}, { $set: { phoneNumber: 'private' } });
    const directory = await groupServiceFor(model.Groups, blocks).getGroupMembers(String(group), String(c));
    expect(directory.members).toHaveLength(3);
    expect(
      directory.members.every(
        (member: any) => member.phoneNumber === undefined,
      ),
    ).toBe(true);
  });
  it('denies every signing/read path after blocking, including owner access to direct images', async () => {
    const message = await db.db
      .collection('ChatMessages')
      .insertOne({ sender: a, receiver: b });
    const resourceId = String(message.insertedId),
      key = 'chat/conversation/message/photo.jpg';
    await db.db.collection('PhotoUploads').insertOne({
      owner: String(a),
      key,
      state: 'attached',
      ref: `chat:${resourceId}`,
    });
    const storage: any = {
      getSignedURL: jest.fn().mockResolvedValue('signed'),
      readVerified: jest.fn().mockResolvedValue(Buffer.from('photo')),
    };
    const photos = new PhotosService(db, storage);
    const context: any = {
      ownerId: String(a),
      requester: String(b),
      resourceType: 'chat',
      resourceId,
    };
    expect(await photos.accessUrl(key, 120, context)).toBe('signed');
    await blocks.block(String(a), String(b));
    await expect(photos.accessUrl(key, 120, context)).rejects.toThrow(
      'Photo not available',
    );
    await expect(
      photos.accessUrl(key, 120, { ...context, requester: String(a) }),
    ).rejects.toThrow('Photo not available');
    await expect(photos.readChatPhoto(key, context)).rejects.toThrow(
      'Photo not available',
    );
    expect(storage.getSignedURL).toHaveBeenCalledTimes(1);
    expect(storage.readVerified).not.toHaveBeenCalled();
  });
  it('denies a URL or byte response when blocking commits during storage I/O', async () => {
    const message = await db.db
      .collection('ChatMessages')
      .insertOne({ sender: a, receiver: b });
    const resourceId = String(message.insertedId),
      key = 'chat/race/message/photo.jpg';
    await db.db
      .collection('PhotoUploads')
      .insertOne({
        owner: String(a),
        key,
        state: 'attached',
        ref: `chat:${resourceId}`,
      });
    const context: any = {
      ownerId: String(a),
      requester: String(b),
      resourceType: 'chat',
      resourceId,
    };
    const storage: any = {
      getSignedURL: jest.fn(async () => {
        await blocks.block(String(a), String(b));
        return 'must-not-return';
      }),
      readVerified: jest.fn(async () => {
        await blocks.block(String(a), String(b));
        return Buffer.from('must-not-return');
      }),
    };
    const photos = new PhotosService(db, storage);
    await expect(photos.accessUrl(key, 120, context)).rejects.toThrow(
      'Photo not available',
    );
    await blocks.unblock(String(a), String(b));
    await expect(photos.readChatPhoto(key, context)).rejects.toThrow(
      'Photo not available',
    );
  });
  it('disconnects pair sockets, denies typing/receipts/presence and evicts removed group members', async () => {
    const service = chats();
    const gateway = new ChatGateway(
      service,
      {} as any,
      { accountDeletion$: new (require('rxjs').Subject)() } as any,
      blocks,
    );
    const emit = jest.fn(),
      leave = jest.fn(),
      disconnect = jest.fn();
    gateway.server = {
      to: jest.fn(() => ({ emit })),
      in: jest.fn(() => ({
        disconnectSockets: disconnect,
        socketsLeave: leave,
      })),
      use: jest.fn(),
    } as any;
    gateway.afterInit(gateway.server);
    await blocks.block(String(a), String(b));
    expect(disconnect).toHaveBeenCalledTimes(2);
    emit.mockClear();
    const client: any = { data: { userId: String(a) }, emit: jest.fn() };
    await gateway.handleTyping({ receiver: String(b) }, client);
    await gateway.handleMarkAsRead({ user2: String(b) }, client);
    await gateway.broadcastSavedMessage({
      sender: a,
      receiver: b,
      message: 'blocked',
    });
    (gateway as any).userSockets.set(
      String(b),
      new Set(['device-1', 'device-2']),
    );
    await (gateway as any).broadcastPresence(String(a), 'adminOnline');
    expect(emit).not.toHaveBeenCalled();
    await groupServiceFor(model.Groups, blocks).removeMembers(
      { groupId: String(group), members: [String(b)] },
      String(a),
    );
    expect(leave).toHaveBeenCalledWith(`group:${group}`);
    emit.mockClear();
    await gateway.broadcastSavedMessage({
      sender: a,
      groupId: group,
      message: 'group text',
    });
    expect(gateway.server.to).not.toHaveBeenLastCalledWith(`user:${b}`);
  });
  it('suppresses notifications between pairs and returns minimal paginated block-list fields', async () => {
    await blocks.block(String(a), String(b));
    const notifications = new NotificationService(model.Notifications, blocks);
    expect(
      await notifications.sendNotification(
        String(b),
        String(a),
        'event_message' as any,
        'hidden',
      ),
    ).toBeNull();
    expect(await db.db.collection('Notifications').countDocuments({})).toBe(0);
    const page = await blocks.list(String(a));
    expect(page.blocks).toEqual([
      { id: String(b), name: 'B', createdAt: expect.any(Date) },
    ]);
    const controller = new UserBlocksController(blocks);
    await expect(
      controller.block({ id: String(a) } as any, String(c), {
        blockerId: String(c),
      }),
    ).rejects.toThrow('Invalid block request');
  });
});
