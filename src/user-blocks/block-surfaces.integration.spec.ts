import { Connection, createConnection, Types } from 'mongoose';
import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { ResponseInterceptor } from '../common/interceptors';
import GlobalExceptionFilter from '../common/interceptors/global-exception.filter';
import { PassportModule } from '@nestjs/passport';
import { JwtService } from '@nestjs/jwt';
import request = require('supertest');
import { BlockService } from './block.service';
import { blockContext, blockQueryPlugin } from './block-context';
import { blockIndexes } from './block-indexes';
import { verifyBlockDatabase } from './block-startup';
import { UsersService } from '../users/users.service';
import { UsersController } from '../users/users.controller';
import { PostsService } from '../posts/posts.service';
import { PostsController } from '../posts/posts.controller';
import { AdminPostsController } from '../posts/admin-posts/admin-posts.controller';
import { EventsService } from '../events/events.service';
import { EventsController } from '../events/events.controller';
import { EventMembersController } from '../event-members/event-members.controller';
import { EventMembersService } from '../event-members/event-members.service';
import { groupServiceFor } from './block.fixture';
import { NotificationService } from '../notification/notification.service';
import { PhotosService } from '../photos/photos.service';
import { PhotoResponseInterceptor } from '../photos/response.interceptor';
import { S3BucketService } from '../s3-bucket/s3-bucket.service';
import { MailService } from '../mail/mail.service';
import { JwtStrategy } from '../common/guards/jwt.strategy';
import { RolesGuard } from '../common/guards/roles.guard';
import { UsersSchema, PostsSchema } from '../common/schemas';
import { CommentSchema } from '../common/schemas/comment.schema';
import { LikeSchema } from '../common/schemas/like.schema';
import { FollowSchema } from '../common/schemas/follow.schema';
import { PostRequestSchema } from '../common/schemas/posts-request.schema';
import { UserBookMarkSchema } from '../common/schemas/user-bookmark.schema';
import { PostBookMarkSchema } from '../common/schemas/posts-bookmark.schema';
import { UserEditHistorySchema } from '../common/schemas/user-profile-edit.schema';
import { EventsSchema } from '../common/schemas/events.schema';
import { EventMembersSchema } from '../common/schemas/event-members.schema';
import { GroupSchema } from '../common/schemas/group-chat.schema';
import { ChatMessageSchema } from '../common/schemas/chats.schema';
import { NotificationSchema } from '../common/schemas/notification.schema';
import { ChatService } from '../chats/chats.service';
import { ChatGateway } from '../chats/chats.gateway';
import { ChatsController } from '../chats/chats.controller';
import { Server } from 'socket.io';
import { createServer } from 'http';

const integration = process.env.TEST_MONGO_URI ? describe : describe.skip;
integration('Phase 1 surface verification', () => {
  let db: Connection, blocks: BlockService, app: any;
  const name = `darkfantasy_surface_test_${randomUUID().replace(/-/g, '')}`;
  const a = new Types.ObjectId(),
    b = new Types.ObjectId(),
    c = new Types.ObjectId(),
    group = new Types.ObjectId();
  const postIds = new Map(
    [a, b, c].map((id) => [String(id), new Types.ObjectId()]),
  );
  const eventIds = new Map(
    [a, b, c].map((id) => [String(id), new Types.ObjectId()]),
  );
  const model: Record<string, any> = {};
  const jwt = new JwtService({ secret: `test-only-${randomUUID()}` });
  const secret = (jwt as any).options.secret;
  const actor = (viewer: Types.ObjectId) =>
    ({ id: String(viewer), roles: ['admin'] }) as any;
  const as = <T>(viewer: Types.ObjectId, fn: () => T) =>
    blockContext.run({ viewerId: String(viewer) }, fn);
  const users = () =>
    new UsersService(
      model.Users,
      model.UserEditHistory,
      model.Follow,
      model.Posts,
      model.PostRequest,
      model.UserBookMark,
      model.ChatMessage,
      blocks,
    );
  const posts = () =>
    new PostsService(
      model.Posts,
      model.Comment,
      model.Like,
      model.Follow,
      model.PostRequest,
      model.PostBookMark,
    );
  const events = () => new EventsService(model.Events, model.EventMembers);
  const notices = () => new NotificationService(model.Notification, blocks);
  const members = () =>
    new EventMembersService(model.EventMembers, model.Events, notices());
  const chats = (photos: any = {}) =>
    new ChatService(
      model.ChatMessage,
      model.Users,
      model.Group,
      { create: jest.fn() } as any,
      {} as any,
      photos,
      blocks,
    );
  const idOf = (value: any) => String(value?._id || value);
  beforeAll(async () => {
    db = await createConnection(process.env.TEST_MONGO_URI, {
      dbName: name,
      monitorCommands: true,
      autoIndex: false,
    }).asPromise();
    await verifyBlockDatabase(db);
    db.plugin(blockQueryPlugin);
    for (const [key, schema] of Object.entries({
      Users: UsersSchema,
      Posts: PostsSchema,
      Comment: CommentSchema,
      Like: LikeSchema,
      Follow: FollowSchema,
      PostRequest: PostRequestSchema,
      UserBookMark: UserBookMarkSchema,
      PostBookMark: PostBookMarkSchema,
      UserEditHistory: UserEditHistorySchema,
      Events: EventsSchema,
      EventMembers: EventMembersSchema,
      Group: GroupSchema,
      ChatMessage: ChatMessageSchema,
      Notification: NotificationSchema,
    }))
      model[key] = db.model(key, schema.clone());
    blocks = new BlockService(db);
    await blockIndexes(db, true, () => {});
    const photos = new PhotosService(db, {} as any);
    const module = await Test.createTestingModule({
      imports: [PassportModule.register({ defaultStrategy: 'jwt' })],
      controllers: [
        UsersController,
        PostsController,
        AdminPostsController,
        EventsController,
        EventMembersController,
        ChatsController,
      ],
      providers: [
        RolesGuard,
        {
          provide: JwtStrategy,
          useValue: new JwtStrategy({ get: () => secret } as any, db),
        },
        { provide: UsersService, useValue: users() },
        { provide: PostsService, useValue: posts() },
        { provide: EventsService, useValue: events() },
        { provide: EventMembersService, useValue: members() },
        { provide: PhotosService, useValue: photos },
        { provide: ChatService, useValue: chats(photos) },
        {
          provide: ChatGateway,
          useValue: { broadcastSavedMessage: jest.fn() },
        },
        { provide: S3BucketService, useValue: {} },
        { provide: MailService, useValue: {} },
      ],
    }).compile();
    app = module.createNestApplication();
    app.use((_req, _res, next) => blockContext.run({}, next));
    app.useGlobalInterceptors(
      new ResponseInterceptor(),
      new PhotoResponseInterceptor(photos),
    );
    app.useGlobalPipes(new ValidationPipe());
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.init();
  });
  beforeEach(async () => {
    for (const collection of await db.db.collections())
      await collection.deleteMany({});
    await db.db.collection('Users').insertMany(
      [a, b, c].map((id, index) => ({
        _id: id,
        displayname: ['A', 'B', 'C'][index],
        username: `u${index}`,
        roles: ['admin'],
        isOnline: true,
        isBlocked: false,
        phoneNumber: 'private',
      })),
    );
    for (const owner of [a, b, c]) {
      const post = postIds.get(String(owner)),
        event = eventIds.get(String(owner));
      const likes = [a, b, c].map((user) => ({
        _id: new Types.ObjectId(),
        post,
        user,
      }));
      const comments = [a, b, c].map((user) => ({
        _id: new Types.ObjectId(),
        post,
        user,
        content: `comment-${user}`,
        createdAt: new Date(),
      }));
      await db.db.collection('Likes').insertMany(likes);
      await db.db.collection('Comments').insertMany(comments);
      await db.db.collection('Posts').insertOne({
        _id: post,
        user: owner,
        caption: 'post',
        visibility: 'public',
        status: 'approved',
        likes: likes.map((row) => row._id),
        comments: comments.map((row) => row._id),
        media: [],
        __v: 0,
      });
      await db.db.collection('Events').insertOne({
        _id: event,
        creator: owner,
        name: 'Event',
        description: 'Event',
        startAt: new Date(),
        endAt: new Date(Date.now() + 3600000),
      });
      await db.db
        .collection('EventMembers')
        .insertMany(
          [a, b, c].map((user) => ({ user, event, requestStatus: 'accepted' })),
        );
      await db.db
        .collection('Groups')
        .updateOne(
          { _id: group },
          { $set: { name: 'Shared group', admin: a, members: [a, b, c] } },
          { upsert: true },
        );
      for (const target of [a, b, c].filter((id) => !id.equals(owner))) {
        await db.db.collection('follows').insertOne({
          follower: owner,
          following: target,
          status: 'accepted',
        });
        await db.db
          .collection('UserBookMark')
          .insertOne({ userId: owner, bookMarkUser: target, status: true });
        await db.db.collection('PostBookMark').insertOne({
          userId: owner,
          postId: postIds.get(String(target)),
          status: true,
        });
        await db.db.collection('Notifications').insertOne({
          receiver: owner,
          sender: target,
          message: 'queued before block',
          type: 'event_message',
        });
      }
    }
    await blocks.block(String(a), String(b));
  });
  afterAll(async () => {
    await app?.close();
    if (db) {
      if (db.name === name) await db.dropDatabase();
      await db.close();
    }
  });
  const directions = [
    { label: 'blocker to blocked', viewer: a, peer: b },
    { label: 'blocked to blocker', viewer: b, peer: a },
  ];
  const checks: Array<
    [string, (viewer: Types.ObjectId, peer: Types.ObjectId) => Promise<void>]
  > = [
    [
      'discovery',
      async (viewer, peer) => {
        const rows = await users().findAll({ limit: 2 } as any);
        expect(rows.count).toBe(2);
        expect(rows.users).toHaveLength(2);
        expect(rows.users.map(idOf)).not.toContain(String(peer));
      },
    ],
    [
      'directory',
      async (_viewer, peer) => {
        const rows = await users().findAll({
          skip: 1,
          limit: 1,
          sortBy: '_id',
          order: 1,
        } as any);
        expect(rows.count).toBe(2);
        expect(rows.users).toHaveLength(1);
        expect(rows.users.map(idOf)).not.toContain(String(peer));
      },
    ],
    [
      'search',
      async (_viewer, peer) => {
        const rows = await users().findAll({
          displayname: peer.equals(a) ? 'A' : 'B',
          limit: 1,
        } as any);
        expect(rows).toEqual({ users: [], count: 0 });
      },
    ],
    [
      'suggestions including random-online-admin',
      async (_viewer, peer) => {
        expect((await users().findUsers()).map(idOf)).not.toContain(
          String(peer),
        );
        expect((await users().findAdmin()).map(idOf)).not.toContain(
          String(peer),
        );
        expect(
          (await users().findAll({ limit: 12 } as any)).users.map(idOf),
        ).not.toContain(String(peer));
        for (let i = 0; i < 5; i++)
          expect(idOf((await users().getRandomOnlineAdmin()).admin)).not.toBe(
            String(peer),
          );
      },
    ],
    [
      'profile view',
      async (viewer, peer) => {
        expect(
          await users().findByIdWithUserPost(String(peer), String(viewer)),
        ).toBeNull();
      },
    ],
    [
      'profile posts',
      async (viewer, peer) => {
        expect(
          await users().findByIdWithUserPost(String(peer), String(viewer)),
        ).toBeNull();
        const user = await users().findByIdWithUserPost(
          String(c),
          String(viewer),
        );
        expect(user.usersPost[0].likes).toHaveLength(2);
        expect(user.usersPost[0].comments).toHaveLength(2);
      },
    ],
    [
      'feed authors',
      async (viewer, peer) => {
        const feed = await posts().findAllPublic(
          { limit: 2 } as any,
          String(viewer),
        );
        expect(feed.count).toBe(2);
        expect(feed.posts.map((row) => idOf(row.user))).not.toContain(
          String(peer),
        );
      },
    ],
    [
      'nested comment authors',
      async (viewer, peer) => {
        const feed = await posts().findAllPublic({} as any, String(viewer));
        const post: any = feed.posts.find(
          (row) => idOf(row.user) === String(c),
        );
        expect(post.comments).toHaveLength(2);
        expect(post.comments.map((row) => idOf(row.user))).not.toContain(
          String(peer),
        );
      },
    ],
    [
      'nested like users',
      async (viewer, peer) => {
        const feed = await posts().findAllPublic({} as any, String(viewer));
        const post: any = feed.posts.find(
          (row) => idOf(row.user) === String(c),
        );
        expect(post.likes).toHaveLength(2);
        expect(post.likes.map((row) => idOf(row.user))).not.toContain(
          String(peer),
        );
      },
    ],
    [
      'like and comment counts',
      async (viewer) => {
        const feed = await posts().findAllPublic({} as any, String(viewer));
        expect(
          feed.posts.every(
            (row) => row.likeCount === 2 && row.commentCount === 2,
          ),
        ).toBe(true);
        const comments = await posts().listComments(
          String(postIds.get(String(c))),
          String(viewer),
          { limit: 1 } as any,
        );
        expect(comments.count).toBe(2);
        expect(comments.comments).toHaveLength(1);
        expect(comments.hasMore).toBe(true);
      },
    ],
    [
      'post detail',
      async (viewer, peer) => {
        const controller = Object.assign(
          Object.create(PostsController.prototype),
          { postsService: posts() },
        );
        expect(
          await controller.findOne(
            String(postIds.get(String(peer))),
            actor(viewer),
          ),
        ).toEqual(
          await controller.findOne(String(new Types.ObjectId()), actor(viewer)),
        );
        const visible: any = await posts().findVisiblePost(
          String(postIds.get(String(c))),
          String(viewer),
        );
        expect(visible.likes).toHaveLength(2);
        expect(visible.comments).toHaveLength(2);
      },
    ],
    [
      'user bookmarks',
      async (viewer, peer) => {
        const rows = await users().getUserBookMark(String(viewer));
        expect(rows).toHaveLength(1);
        expect(rows.map((row) => idOf(row.bookMarkUser))).not.toContain(
          String(peer),
        );
      },
    ],
    [
      'post bookmarks',
      async (viewer, peer) => {
        const rows = await posts().getPostBookMark(String(viewer));
        expect(rows).toHaveLength(1);
        expect(rows[0].postId.user._id).not.toEqual(peer);
        expect(rows[0].postId.likeCount).toBe(2);
        expect(rows[0].postId.commentCount).toBe(2);
      },
    ],
    [
      'post access requests',
      async (viewer, peer) => {
        await db.db.collection('PostRequest').insertMany([
          { userId: viewer, requestedUserId: peer, status: 'pending' },
          { userId: viewer, requestedUserId: c, status: 'pending' },
        ]);
        const rows = await posts().getPendingRequest(String(viewer));
        expect(rows).toHaveLength(1);
        expect(rows.map((row) => idOf(row.requestedUserId))).not.toContain(
          String(peer),
        );
        await expect(
          posts().sendPostRequest(String(peer), String(viewer)),
        ).rejects.toThrow('User not found!');
        expect(
          await posts().approvePostEditRequest(
            String(peer),
            String(viewer),
            'accepted',
          ),
        ).toBeNull();
      },
    ],
    [
      'event lists',
      async (_viewer, peer) => {
        const rows = await events().filter({ limit: 1 } as any);
        expect(rows.count).toBe(2);
        expect(rows.events).toHaveLength(1);
        expect(rows.events.map((row) => idOf(row.creator))).not.toContain(
          String(peer),
        );
      },
    ],
    [
      'event attendee previews and counts',
      async (_viewer, peer) => {
        await db.db.collection('EventMembers').insertOne({
          event: eventIds.get(String(c)),
          user: c,
          requestStatus: 'pending',
        });
        const rows: any = await events().filter({
          _id: String(eventIds.get(String(c))),
        } as any);
        expect(rows.events).toHaveLength(1);
        expect(rows.events[0].users).toHaveLength(2);
        expect(rows.events[0].users.map(idOf)).not.toContain(String(peer));
        const event = eventIds.get(String(c));
        expect(
          await model.EventMembers.countDocuments({
            event,
            requestStatus: 'accepted',
          }),
        ).toBe(2);
      },
    ],
    [
      'event participants',
      async (_viewer, peer) => {
        const rows = await members().getParticipants(
          String(eventIds.get(String(c))),
        );
        expect(rows).toHaveLength(2);
        expect(rows.map((row) => idOf(row.user))).not.toContain(String(peer));
        expect(
          await members().getParticipants(String(eventIds.get(String(peer)))),
        ).toHaveLength(0);
      },
    ],
    [
      'event applications',
      async (viewer, peer) => {
        const event = eventIds.get(String(viewer));
        await db.db
          .collection('EventMembers')
          .updateMany({ event }, { $set: { requestStatus: 'pending' } });
        const rows = await members().getPendingRequestsForCreator(
          String(event),
          String(viewer),
        );
        expect(rows).toHaveLength(2);
        expect(rows.map((row) => idOf(row.user))).not.toContain(String(peer));
      },
    ],
    [
      'followers',
      async (viewer, peer) => {
        const rows = await users().getFollowers(String(viewer));
        expect(rows).toHaveLength(1);
        expect(rows.map(idOf)).not.toContain(String(peer));
      },
    ],
    [
      'following',
      async (viewer, peer) => {
        const rows = await users().getFollowing(String(viewer));
        expect(rows).toHaveLength(1);
        expect(rows.map(idOf)).not.toContain(String(peer));
      },
    ],
    [
      'pending follow requests',
      async (viewer, peer) => {
        await db.db.collection('follows').insertMany([
          { follower: peer, following: viewer, status: 'pending' },
          { follower: c, following: viewer, status: 'pending' },
        ]);
        const rows = await users().getFollowRequests(String(viewer));
        expect(rows).toHaveLength(1);
        expect(rows.map((row) => idOf(row.follower))).not.toContain(
          String(peer),
        );
      },
    ],
    [
      'group member directory',
      async (viewer, peer) => {
        const row = await groupServiceFor(model.Group, blocks).getGroupMembers(
          String(group),
          String(viewer),
        );
        expect(row.members).toHaveLength(2);
        expect(row.members.map(idOf)).not.toContain(String(peer));
        expect(row.members.every((user: any) => !user.phoneNumber)).toBe(true);
        expect(
          (await db.db.collection('Groups').findOne({ _id: group })).members,
        ).toHaveLength(3);
      },
    ],
    [
      'notification reads and persisted queued notices',
      async (viewer, peer) => {
        const rows = await model.Notification.find({ receiver: viewer }).limit(
          1,
        );
        expect(rows).toHaveLength(1);
        expect(rows.map((row) => idOf(row.sender))).not.toContain(String(peer));
        expect(
          await model.Notification.countDocuments({ receiver: viewer }),
        ).toBe(1);
        expect(
          await db.db
            .collection('Notifications')
            .countDocuments({ receiver: viewer }),
        ).toBe(2);
      },
    ],
    [
      'notification creation',
      async (viewer, peer) => {
        expect(
          await notices().sendNotification(
            String(peer),
            String(viewer),
            'event_message' as any,
            'hidden',
          ),
        ).toBeNull();
      },
    ],
  ];
  for (const { label, viewer, peer } of directions)
    for (const [surface, check] of checks)
      it(`${surface}: ${label}`, () => as(viewer, () => check(viewer, peer)));

  it.each(directions)(
    'direct chat delivery checks, updates/deletes, image URLs and API bytes: $label',
    async ({ viewer, peer }) => {
      const own = await model.ChatMessage.create({
        sender: viewer,
        receiver: peer,
        message: 'unchanged',
        media: [
          {
            storageKey: 'chat/normal.jpg',
            mimetype: 'image/jpeg',
            checksum: 'ok',
          },
        ],
      });
      const incoming = await model.ChatMessage.create({
        sender: peer,
        receiver: viewer,
        viewOnce: true,
        media: [
          {
            storageKey: 'chat/once.jpg',
            mimetype: 'image/jpeg',
            checksum: 'ok',
          },
        ],
      });
      const storage: any = {
        accessUrl: jest.fn(),
        readChatPhoto: jest.fn(),
        enqueue: jest.fn(),
        release: jest.fn(),
      };
      const service = chats(storage);
      await expect(
        service.saveTextMessage({
          sender: String(viewer),
          receiver: String(peer),
          message: 'denied',
        }),
      ).rejects.toThrow('Conversation not found');
      await expect(
        service.createMediaMessage(String(viewer), {
          receiver: String(peer),
          photoIds: ['photo'],
          clientId: 'test-client-id',
        } as any),
      ).rejects.toThrow('Conversation not found');
      await expect(
        service.getChatHistory(String(viewer), String(peer)),
      ).rejects.toThrow('Conversation not found');
      await expect(
        service.updateMessage(String(own._id), String(viewer), 'changed'),
      ).rejects.toThrow('Message not found');
      await expect(
        service.deleteMessage(String(own._id), String(viewer)),
      ).rejects.toThrow('Message not found');
      await expect(
        service.getMediaAccessUrl(
          String(viewer),
          String(own._id),
          String(own.media[0]._id),
        ),
      ).rejects.toThrow('Message not found');
      await expect(
        service.openRestrictedPhoto(
          String(viewer),
          String(incoming._id),
          String(incoming.media[0]._id),
        ),
      ).rejects.toThrow('Message not found');
      expect(storage.accessUrl).not.toHaveBeenCalled();
      expect(storage.readChatPhoto).not.toHaveBeenCalled();
      expect(storage.enqueue).not.toHaveBeenCalled();
      const emitted = jest.fn(),
        gateway = new ChatGateway(service, jwt, {} as any, blocks);
      gateway.server = { to: jest.fn(() => ({ emit: emitted })) } as any;
      (gateway as any).userSockets.set(
        String(peer),
        new Set(['device-one', 'device-two']),
      );
      const client: any = { data: { userId: String(viewer) }, emit: jest.fn() };
      await gateway.handleTyping({ receiver: String(peer) }, client);
      await gateway.handleMarkAsRead({ user2: String(peer) }, client);
      await gateway.broadcastSavedMessage(
        { sender: viewer, receiver: peer, message: 'not delivered' },
        'messageUpdated',
      );
      await (gateway as any).broadcastPresence(String(viewer), 'adminOnline');
      expect(emitted).not.toHaveBeenCalled();
      expect(
        (await db.db.collection('ChatMessages').findOne({ _id: own._id }))
          .message,
      ).toBe('unchanged');
      expect(
        (await db.db.collection('ChatMessages').findOne({ _id: own._id }))
          .isRead,
      ).toBe(false);
      const token = jwt.sign({ sub: String(viewer) });
      const response = await request(app.getHttpServer())
        .post(
          `/chats/messages/${incoming._id}/media/${incoming.media[0]._id}/open`,
        )
        .set('Authorization', `Bearer ${token}`)
        .send({});
      expect(response.status).toBe(404);
      expect(response.text).not.toContain('data:image');
    },
  );

  it.each(directions)(
    'byte-identical profile miss and identical Mongo command sequence: $label',
    async ({ viewer, peer }) => {
      const client = db.getClient(),
        token = jwt.sign({ sub: String(viewer) });
      async function lookup(id: string) {
        const commands: any[] = [];
        const normalize = (value: any): any => {
          if (Array.isArray(value)) return value.map(normalize);
          if (!value || typeof value !== 'object' || value._bsontype)
            return value;
          return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [
              key,
              key === '_id' && String(item) === id
                ? '<target>'
                : normalize(item),
            ]),
          );
        };
        const listener = (event: any) => {
          if (event.databaseName === name)
            commands.push({
              kind: event.commandName,
              collection: event.command.find,
              filter: normalize(event.command.filter),
              projection: event.command.projection,
              limit: event.command.limit,
            });
        };
        client.on('commandStarted', listener);
        try {
          const response = await request(app.getHttpServer())
            .get(`/users/${id}`)
            .set('Authorization', `Bearer ${token}`);
          return { status: response.status, bytes: response.text, commands };
        } finally {
          client.off('commandStarted', listener);
        }
      }
      const blocked = await lookup(String(peer)),
        missing = await lookup(String(new Types.ObjectId()));
      expect(blocked.status).toBe(404);
      expect(JSON.parse(blocked.bytes)).toMatchObject({
        statusCode: 404,
        message: 'User not found!',
      });
      expect(blocked.status).toBe(missing.status);
      expect(Buffer.from(blocked.bytes)).toEqual(Buffer.from(missing.bytes));
      expect(blocked.commands).toEqual(missing.commands);
      expect(blocked.commands.every((command) => command.kind === 'find')).toBe(
        true,
      );
      expect(blocked.commands.map((command) => command.collection)).toEqual([
        'Users',
        'AccountPurges',
        'UserBlocks',
        'RestrictedContent',
        'Users',
      ]);
    },
  );
  it('authorized admin tools bypass pair filtering while ordinary admin discovery remains filtered', async () => {
    const token = jwt.sign({ sub: String(b) });
    const admin = await request(app.getHttpServer())
      .get('/admin/posts')
      .set('Authorization', `Bearer ${token}`);
    expect(admin.status).toBe(200);
    expect(admin.body.data.count).toBe(3);
    expect(admin.body.data.posts.map((row) => idOf(row.user))).toContain(
      String(a),
    );
    const ordinary = await request(app.getHttpServer())
      .get('/users')
      .set('Authorization', `Bearer ${token}`);
    expect(ordinary.body.data.users.map(idOf)).not.toContain(String(a));
    await db.db.collection('UserEdits').insertOne({
      user: a,
      remark: 'Review my profile',
      isAdminRequest: false,
    });
    const history = await request(app.getHttpServer())
      .get('/users/history')
      .set('Authorization', `Bearer ${token}`);
    expect(history.status).toBe(200);
    expect(history.body.data.map((row) => idOf(row.user))).toContain(String(a));
    const managed = await request(app.getHttpServer())
      .put(`/admin/posts/${postIds.get(String(a))}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ caption: 'Reviewed by admin' });
    expect(managed.status).toBe(200);
    expect(managed.body.data.caption).toBe('Reviewed by admin');
    const edit = await request(app.getHttpServer())
      .put(`/events/${eventIds.get(String(b))}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Own event updated' });
    expect(edit.status).toBe(200);
    expect(edit.body.data.name).toBe('Own event updated');
    const post = await request(app.getHttpServer())
      .put(`/posts/${postIds.get(String(b))}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ caption: 'Own post updated' });
    expect(post.status).toBe(200);
    expect(post.body.data.likes).toHaveLength(2);
    expect(post.body.data.comments).toHaveLength(2);
    const storedPost = await db.db
      .collection('Posts')
      .findOne({ _id: postIds.get(String(b)) });
    expect(storedPost.likes).toHaveLength(3);
    expect(storedPost.comments).toHaveLength(3);
    expect(
      (await db.db.collection('Posts').findOne({ _id: postIds.get(String(b)) }))
        .caption,
    ).toBe('Own post updated');
    const application = await db.db.collection('EventMembers').findOne({
      event: eventIds.get(String(b)),
      user: a,
    });
    await db.db.collection('EventMembers').updateOne(
      { _id: application._id },
      {
        $set: { requestStatus: 'pending' },
      },
    );
    const pending = await request(app.getHttpServer())
      .get(`/event-members/${eventIds.get(String(b))}/requests/pending`)
      .set('Authorization', `Bearer ${token}`);
    expect(pending.status).toBe(200);
    expect(
      pending.body.data.pendingRequests.map((row) => idOf(row.user)),
    ).toContain(String(a));
    const outsider = await request(app.getHttpServer())
      .put(`/event-members/${application._id}/status`)
      .set('Authorization', `Bearer ${jwt.sign({ sub: String(c) })}`)
      .send({ requestStatus: 'accepted' });
    expect(outsider.status).toBe(403);
    const approved = await request(app.getHttpServer())
      .put(`/event-members/${application._id}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ requestStatus: 'accepted' });
    expect(approved.status).toBe(200);
    expect(approved.body.data.requestStatus).toBe('accepted');
    const removed = await request(app.getHttpServer())
      .delete(`/event-members/${application._id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(removed.status).toBe(200);
    expect(
      await db.db.collection('EventMembers').findOne({ _id: application._id }),
    ).toBeNull();
    await db.db
      .collection('Users')
      .updateOne({ _id: b }, { $set: { roles: ['user'] } });
    const denied = await request(app.getHttpServer())
      .get('/admin/posts')
      .set('Authorization', `Bearer ${token}`);
    expect(denied.status).toBe(403);
  });
  it('concurrent block/unblock/block stays consistent and never revives cancelled requests', async () => {
    await blocks.unblock(String(a), String(b));
    await db.db
      .collection('follows')
      .insertOne({ follower: a, following: b, status: 'pending' });
    await db.db
      .collection('PostRequest')
      .insertOne({ userId: a, requestedUserId: b, status: 'pending' });
    await Promise.all([
      blocks.block(String(a), String(b)),
      blocks.unblock(String(a), String(b)),
      blocks.block(String(a), String(b)),
    ]);
    const count = await db.db
      .collection('UserBlocks')
      .countDocuments({ blockerId: a, blockedId: b });
    expect([0, 1]).toContain(count);
    expect(await blocks.isBlockedEitherWay(String(a), String(b))).toBe(
      count === 1,
    );
    await blocks.block(String(a), String(b));
    expect(
      await db.db
        .collection('UserBlocks')
        .countDocuments({ blockerId: a, blockedId: b }),
    ).toBe(1);
    await blocks.unblock(String(a), String(b));
    await as(a, async () =>
      expect(
        await users().findByIdWithUserPost(String(b), String(a)),
      ).not.toBeNull(),
    );
    expect(
      await db.db
        .collection('follows')
        .countDocuments({ follower: a, following: b, status: 'pending' }),
    ).toBe(0);
    expect(
      await db.db
        .collection('PostRequest')
        .countDocuments({ userId: a, requestedUserId: b, status: 'pending' }),
    ).toBe(0);
  });
  it('real reconnect denies group images in both directions and removes every device from the group room', async () => {
    await blocks.unblock(String(a), String(b));
    const http = createServer(),
      io = new Server(http);
    const photos = new PhotosService(db, {
      getSignedURL: jest.fn().mockResolvedValue('https://signed.test/group'),
    } as any);
    const service = chats(photos),
      gateway = new ChatGateway(service, jwt, photos, blocks);
    gateway.server = io;
    gateway.afterInit(io);
    io.on('connection', (socket) => {
      socket.on('joinGroup', async (id, ack) => {
        const result = await gateway.handleJoinGroup(socket, id);
        ack(result);
      });
      void gateway.handleConnection(socket);
      socket.on('disconnect', () => {
        void gateway.handleDisconnect(socket);
      });
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const address = http.address() as any;
    const connect = require('socket.io-client').io;
    const clients: any[] = [];
    const once = (socket: any, event: string) =>
      new Promise<any>((resolve) => socket.once(event, resolve));
    const join = (socket: any) =>
      new Promise<void>((resolve, reject) =>
        socket
          .timeout(3000)
          .emit('joinGroup', String(group), (error, data) =>
            error || !data
              ? reject(error || Error('Join rejected'))
              : resolve(),
          ),
      );
    try {
      for (const user of [a, b, b]) {
        const socket = connect(`http://127.0.0.1:${address.port}`, {
          autoConnect: false,
          reconnection: false,
          transports: ['websocket'],
          auth: { token: jwt.sign({ sub: String(user) }) },
        });
        clients.push(socket);
        const connected = once(socket, 'connect');
        socket.connect();
        await connected;
        await join(socket);
      }
      const images: any[] = [];
      for (const sender of [a, b]) {
        const message = await model.ChatMessage.create({
          sender,
          groupId: group,
          media: [
            {
              storageKey: `chat/${sender}/image.jpg`,
              mimetype: 'image/jpeg',
              checksum: 'ok',
            },
          ],
        });
        const key = `chat/${sender}/image.jpg`;
        await db.db.collection('PhotoUploads').insertOne({
          owner: String(sender),
          key,
          state: 'attached',
          ref: `chat:${message._id}`,
        });
        images.push(message);
      }
      const disconnected = clients.map((socket) => once(socket, 'disconnect'));
      await blocks.block(String(a), String(b));
      await Promise.all(disconnected);
      for (const socket of clients) {
        const connected = once(socket, 'connect');
        socket.connect();
        await connected;
        await join(socket);
      }
      expect((await io.in(`group:${group}`).allSockets()).size).toBe(3);
      await expect(
        service.getMediaAccessUrl(
          String(a),
          String(images[1]._id),
          String(images[1].media[0]._id),
        ),
      ).rejects.toThrow('Media not found');
      await expect(
        service.getMediaAccessUrl(
          String(b),
          String(images[0]._id),
          String(images[0].media[0]._id),
        ),
      ).rejects.toThrow('Media not found');
      for (const [index, image] of images.entries()) {
        const delivered = clients.map((socket) =>
          once(socket, 'receiveGroupMessage'),
        );
        await gateway.broadcastSavedMessage(image.toObject());
        const payloads = await Promise.all(delivered);
        const peerIndexes = index === 0 ? [1, 2] : [0];
        for (const peerIndex of peerIndexes) {
          expect(payloads[peerIndex].blockedSender).toBe(true);
          expect(payloads[peerIndex].media).toEqual([]);
        }
        expect(payloads[index === 0 ? 0 : 1].media).toHaveLength(1);
      }
      for (const [viewer, peer] of [
        [a, b],
        [b, a],
      ]) {
        const history = await service.getChatGroupHistory(
          String(viewer),
          String(group),
        );
        const peerImage = history.find(
          (message) => idOf(message.sender) === String(peer),
        );
        expect(peerImage.blockedSender).toBe(true);
        expect(peerImage.media).toEqual([]);
      }
      const left = once(clients[1], 'groupRemoved'),
        right = once(clients[2], 'groupRemoved');
      await groupServiceFor(model.Group, blocks).removeMembers(
        { groupId: String(group), members: [String(b)] },
        String(a),
      );
      await Promise.all([left, right]);
      const remaining = await io.in(`group:${group}`).allSockets();
      expect(remaining.has(clients[0].id)).toBe(true);
      expect(remaining.has(clients[1].id)).toBe(false);
      expect(remaining.has(clients[2].id)).toBe(false);
      const deliveries: any[] = [];
      clients[1].on('receiveGroupMessage', (value) => deliveries.push(value));
      clients[2].on('receiveGroupMessage', (value) => deliveries.push(value));
      const received = once(clients[0], 'receiveGroupMessage');
      await gateway.broadcastSavedMessage({
        sender: a,
        groupId: group,
        message: 'only current members',
      });
      await received;
      expect(deliveries).toEqual([]);
    } finally {
      clients.forEach((socket) => socket.disconnect());
      await new Promise<void>((resolve) => io.close(() => resolve()));
      // Socket disconnect handlers update status asynchronously; drain them before
      // the next fixture can reset its database.
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  });
});
