import { GoneException } from '@nestjs/common';
import { createConnection, Connection, Model, Types } from 'mongoose';
import { randomUUID } from 'crypto';
import {
  ChatMessage,
  ChatMessageDocument,
  ChatMessageSchema,
} from '../common/schemas/chats.schema';
import { ChatService } from './chats.service';
import { BlockService } from '../user-blocks/block.service';

// Always use a randomly named disposable database, never application collections.
const integration = process.env.TEST_MONGO_URI ? describe : describe.skip;
integration('Single-opening photos with real MongoDB', () => {
  let db: Connection;
  let model: Model<ChatMessage>;
  let photos: any;
  const database = 'darkfantasy_chat_test_' + randomUUID().replace(/-/g, '');
  const sender = new Types.ObjectId();
  const receiver = new Types.ObjectId();
  const service = () =>
    new ChatService(
      model as unknown as Model<ChatMessageDocument>,
      {} as any,
      {} as any,
      { create: jest.fn() } as any,
      {} as any,
      photos,
      new BlockService(db),
    );
  const photo = (storedReceiver: Types.ObjectId | string = receiver) =>
    model.create({
      sender,
      receiver: storedReceiver,
      type: 'media',
      viewOnce: true,
      viewDurationSeconds: 10,
      media: [
        {
          storageKey: 'chat/private/photo.jpg',
          mimetype: 'image/jpeg',
          checksum: 'verified',
          status: 'active',
        },
      ],
    });

  beforeAll(async () => {
    db = await createConnection(process.env.TEST_MONGO_URI, {
      dbName: database,
      serverSelectionTimeoutMS: 5000,
    }).asPromise();
    model = db.model(ChatMessage.name, ChatMessageSchema);
  });
  beforeEach(() => {
    photos = {
      readChatPhoto: jest
        .fn()
        .mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff])),
    };
  });
  afterAll(async () => {
    if (!db) return;
    if (db.name === database && database.startsWith('darkfantasy_chat_test_'))
      await db.dropDatabase();
    await db.close();
  });

  it.each([receiver, String(receiver)])(
    'returns bytes to exactly one device for stored recipient %s',
    async (storedReceiver) => {
      const message: any = await photo(storedReceiver);
      const id = String(message._id),
        mediaId = String(message.media[0]._id);
      const results = await Promise.allSettled([
        service().openRestrictedPhoto(String(receiver), id, mediaId),
        service().openRestrictedPhoto(String(receiver), id, mediaId),
      ]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === 'rejected'),
      ).toHaveLength(1);
      const saved = await model.findById(id);
      expect(saved.viewedAt).toBeInstanceOf(Date);
      expect(
        saved.media[0].expiresAt.getTime() - saved.viewedAt.getTime(),
      ).toBe(10000);
      // A fresh service instance has no local consumed state to rely on.
      await expect(
        service().openRestrictedPhoto(String(receiver), id, mediaId),
      ).rejects.toBeInstanceOf(GoneException);
    },
  );

  it('does not deliver bytes if the sender revokes the photo during the read', async () => {
    const message: any = await photo();
    let release: (bytes: Buffer) => void;
    let started: () => void;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    photos.readChatPhoto.mockImplementation(
      () =>
        new Promise<Buffer>((resolve) => {
          release = resolve;
          started();
        }),
    );
    const opening = service().openRestrictedPhoto(
      String(receiver),
      String(message._id),
      String(message.media[0]._id),
    );
    // Attach the rejection handler before releasing the pending storage read.
    const rejected = expect(opening).rejects.toBeInstanceOf(GoneException);
    await reading;
    await model.updateOne(
      { _id: message._id },
      { $set: { 'media.0.status': 'revoked' } },
    );
    release(Buffer.from([0xff, 0xd8, 0xff]));
    await rejected;
    expect((await model.findById(message._id)).viewedAt).toBeUndefined();
  });
});
