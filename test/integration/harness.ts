import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose, { Connection, Model, Types } from 'mongoose';
import { UsersSchema } from 'src/common/schemas/users.schema';
import { PostsSchema } from 'src/common/schemas/posts.schema';
import { LikeSchema } from 'src/common/schemas/like.schema';
import { CommentSchema } from 'src/common/schemas/comment.schema';
import { FollowSchema } from 'src/common/schemas/follow.schema';
import { PostRequestSchema } from 'src/common/schemas/posts-request.schema';
import { PostBookMarkSchema } from 'src/common/schemas/posts-bookmark.schema';
import { ChatMessageSchema } from 'src/common/schemas/chats.schema';
import { GroupSchema } from 'src/common/schemas/group-chat.schema';
import { ChatMediaAuditSchema } from 'src/common/schemas/chat-media-audit.schema';
import { ChatReadCursorSchema } from 'src/common/schemas/chat-read-cursor.schema';
import { ChatService } from 'src/chats/chats.service';
import { GroupService } from 'src/group-chat/group.service';
import { PostsService } from 'src/posts/posts.service';

/**
 * Real MongoDB (in-memory replica set) with the application's schemas and
 * indexes; S3 and Socket.IO are replaced by recording fakes.
 */
export class Harness {
  replSet: MongoMemoryReplSet;
  connection: Connection;
  models: Record<string, Model<any>> = {};
  s3 = {
    getSignedURL: jest.fn(async (key: string) => `https://signed.example/${key}`),
    deleteOne: jest.fn(async () => ({})),
    uploadPrivateFile: jest.fn(async () => ({ Key: 'stored' })),
    uploadFile: jest.fn(async () => ({ Key: 'posts/stored', key: 'posts/stored' })),
  };
  gateway = {
    syncGroupMembership: jest.fn(),
    broadcastGroupDeleted: jest.fn(),
    broadcastSavedMessage: jest.fn(),
  };
  chat: ChatService;
  groups: GroupService;
  posts: PostsService;

  async start() {
    this.replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    this.connection = await mongoose
      .createConnection(this.replSet.getUri(), { dbName: 'darkfantasy-test' })
      .asPromise();
    const schemas: Record<string, mongoose.Schema> = {
      Users: UsersSchema,
      Posts: PostsSchema,
      Like: LikeSchema,
      Comment: CommentSchema,
      Follow: FollowSchema,
      PostRequest: PostRequestSchema,
      PostBookMark: PostBookMarkSchema,
      ChatMessage: ChatMessageSchema,
      Group: GroupSchema,
      ChatMediaAudit: ChatMediaAuditSchema,
      ChatReadCursor: ChatReadCursorSchema,
    };
    for (const [name, schema] of Object.entries(schemas)) {
      this.models[name] = this.connection.model(name, schema);
      await this.models[name].init(); // builds the declared indexes
    }
    const m = this.models;
    this.chat = new ChatService(
      m.ChatMessage, m.Users, m.Group, m.ChatMediaAudit, this.s3 as any, m.ChatReadCursor,
    );
    this.groups = new GroupService(m.Group, m.Users, this.chat, this.gateway as any, this.s3 as any);
    this.posts = new PostsService(
      m.Posts, m.Comment, m.Like, m.Follow, m.PostRequest, m.PostBookMark, this.s3 as any,
    );
  }

  async stop() {
    await this.connection?.close();
    await this.replSet?.stop();
  }

  async reset() {
    await Promise.all(Object.values(this.models).map((model) => model.deleteMany({})));
    jest.clearAllMocks();
  }

  /** Inserts users directly (bypassing the password hook) and returns their ids. */
  async users(count: number, extra: Record<string, unknown> = {}): Promise<string[]> {
    const docs = Array.from({ length: count }, (_, index) => {
      const tag = new Types.ObjectId().toHexString();
      return {
        _id: new Types.ObjectId(),
        username: `${tag}@example.test`,
        password: 'hashed',
        displayname: `user-${tag}`,
        firstName: 'Test',
        lastName: `User${index}`,
        roles: ['user'],
        loginCount: 0,
        loginAttempts: 0,
        isBlocked: false,
        blockedBy: 'open',
        status: 'open',
        canEditProfile: false,
        passwordResetToken: `reset-${tag}`,
        verifyEmailToken: `verify-${tag}`,
        ...extra,
      };
    });
    await this.models.Users.collection.insertMany(docs);
    return docs.map((doc) => doc._id.toHexString());
  }

  async post(userId: string, fields: Record<string, unknown> = {}) {
    return this.models.Posts.create({
      user: userId,
      caption: 'caption',
      visibility: 'public',
      status: 'approved',
      media: [{ url: 'https://old.example/expired', filename: 'posts/a.jpg', mimetype: 'image/jpeg', originalname: 'a.jpg' }],
      ...fields,
    });
  }
}

export const clientId = () => `c-${new Types.ObjectId().toHexString()}`;
