import { BadRequestException, GoneException } from '@nestjs/common';
import { Types } from 'mongoose';
import { ChatExpiryService } from 'src/chats/chat-expiry.service';
import { Harness, clientId } from './harness';

describe('Disappearing and view-once messages (MongoDB integration)', () => {
  const h = new Harness();
  beforeAll(() => h.start());
  afterAll(() => h.stop());
  beforeEach(() => h.reset());

  const expire = (id: string) =>
    h.models.ChatMessage.updateOne({ _id: id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });

  /** A stored message with one attachment, as the photo pipeline leaves it. */
  const mediaMessage = (
    sender: string,
    receiver: string,
    fields: Record<string, unknown> = {},
    media: Record<string, unknown> = {},
  ) =>
    h.models.ChatMessage.create({
      sender: new Types.ObjectId(sender),
      receiver: new Types.ObjectId(receiver),
      type: 'media',
      media: [{
        storageKey: `chat/${new Types.ObjectId()}.jpg`,
        checksum: 'checksum',
        mimetype: 'image/jpeg',
        status: 'active',
        ...media,
      }],
      ...fields,
    });

  describe('disappearing messages', () => {
    it('stores the expiry from an allowed timer and rejects other values', async () => {
      const [alice, bob] = await h.users(2);
      const before = Date.now();
      const sent = await h.chat.saveTextMessage({ sender: alice, receiver: bob, message: 'soon gone', ttlSeconds: 300 });
      const expiresAt = new Date(sent.expiresAt).getTime();
      expect(expiresAt - new Date(sent.sentAt).getTime()).toBe(300_000);
      expect(expiresAt).toBeGreaterThanOrEqual(before + 300_000);

      const viaRest = await h.chat.createMediaMessage(alice, { receiver: bob, message: 'rest', ttlSeconds: 30 }, []);
      expect(new Date(viaRest.expiresAt).getTime()).toBeGreaterThanOrEqual(before + 30_000);

      for (const ttlSeconds of [1, 31, -30, 'abc', true]) {
        await expect(
          h.chat.saveTextMessage({ sender: alice, receiver: bob, message: 'x', ttlSeconds }),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      const plain = await h.chat.saveTextMessage({ sender: alice, receiver: bob, message: 'stays' });
      expect(plain.expiresAt).toBeUndefined();
    });

    it('hides an expired message from history, unread, conversations and media access before it is purged', async () => {
      const [alice, bob] = await h.users(2);
      const kept = await h.chat.saveTextMessage({ sender: alice, receiver: bob, message: 'kept' });
      const timed = await h.chat.saveTextMessage({ sender: alice, receiver: bob, message: 'secret', ttlSeconds: 30 });
      expect((await h.chat.getChatHistory(bob, alice, { limit: 50 })).map((m) => m.message)).toEqual(['kept', 'secret']);

      await expire(timed._id);
      expect((await h.chat.getChatHistory(bob, alice, { limit: 50 })).map((m) => m.message)).toEqual(['kept']);
      expect((await h.chat.getChatHistory(bob, alice)).map((m) => m.message)).toEqual(['kept']);
      expect((await h.chat.getUnreadMessageCount(bob)).map((m) => String(m._id))).toEqual([String(kept._id)]);
      const [conversation] = await h.chat.getConversations(bob);
      expect(conversation.lastMessage.message).toBe('kept');
      expect(conversation.unreadCount).toBe(1);
      await expect(h.chat.updateMessage(String(timed._id), alice, 'edit')).rejects.toBeInstanceOf(GoneException);
      // The row still exists until the sweeper runs.
      expect(await h.models.ChatMessage.countDocuments()).toBe(2);
    });

    it('pages past a cursor message that expired after it was loaded', async () => {
      const [alice, bob] = await h.users(2);
      const first = await h.chat.saveTextMessage({ sender: alice, receiver: bob, message: 'first' });
      await h.models.ChatMessage.updateOne({ _id: first._id }, { $set: { sentAt: new Date(Date.now() - 2000) } });
      const cursor = await h.chat.saveTextMessage({ sender: alice, receiver: bob, message: 'cursor', ttlSeconds: 30 });
      await expire(cursor._id);
      const older = await h.chat.getChatHistory(bob, alice, { limit: 10, before: String(cursor._id) });
      expect(older.map((m) => m.message)).toEqual(['first']);
    });

    it('hides expired group messages from members', async () => {
      const [owner, member] = await h.users(2);
      const group = await h.groups.createGroup({ name: 'g', members: [member], clientId: clientId() } as any, owner);
      const timed = await h.chat.saveTextMessage({ sender: owner, groupId: String(group._id), message: 'gone', ttlSeconds: 30 });
      await expire(timed._id);
      expect(await h.chat.getChatGroupHistory(member, String(group._id), { limit: 50 })).toEqual([]);
      const conversations = await h.chat.getConversations(member);
      expect(conversations.find((c) => c.kind === 'group').lastMessage).toBeNull();
    });

    it('sweeper deletes expired messages, queues their media, and broadcasts each deletion', async () => {
      const [alice, bob] = await h.users(2);
      const timed = await mediaMessage(alice, bob, { expiresAt: new Date(Date.now() + 30_000) });
      const key = timed.media[0].storageKey;
      const kept = await h.chat.saveTextMessage({ sender: alice, receiver: bob, message: 'kept', ttlSeconds: 3600 });
      await expire(timed._id);

      const sweeper = new ChatExpiryService(h.chat, h.gateway as any);
      await sweeper.sweep();

      expect(await h.models.ChatMessage.exists({ _id: timed._id })).toBeNull();
      expect(await h.models.ChatMessage.exists({ _id: kept._id })).not.toBeNull();
      expect(h.photos.enqueue).toHaveBeenCalledWith([key]);
      expect(h.s3.deleteOne).not.toHaveBeenCalled();
      expect(h.gateway.broadcastSavedMessage).toHaveBeenCalledTimes(1);
      expect(h.gateway.broadcastSavedMessage).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: String(timed._id) }),
        'messageDeleted',
      );
    });
  });

  describe('restricted (view-once) photos', () => {
    it('are excluded from the media gallery', async () => {
      const [alice, bob] = await h.users(2);
      await mediaMessage(alice, bob, { viewOnce: true });
      const normal = await mediaMessage(alice, bob);
      const gallery = await h.chat.listConversationMedia(bob, { receiver: alice });
      expect(gallery.map((item) => String(item.messageId))).toEqual([String(normal._id)]);
    });

    it('sweeper queues the stored file once the viewing window ends and marks the media revoked', async () => {
      const [alice, bob] = await h.users(2);
      const viewedAt = new Date();
      const sent = await mediaMessage(
        alice,
        bob,
        { viewOnce: true, viewDurationSeconds: 10, viewedAt },
        { expiresAt: new Date(viewedAt.getTime() + 10_000) },
      );
      const key = sent.media[0].storageKey;

      const sweeper = new ChatExpiryService(h.chat, h.gateway as any);
      await sweeper.sweep(viewedAt); // still inside the viewing window: nothing removed
      expect(h.photos.enqueue).not.toHaveBeenCalled();

      await sweeper.sweep(new Date(viewedAt.getTime() + 11_000));
      expect(h.photos.enqueue).toHaveBeenCalledWith([key]);
      const stored = await h.models.ChatMessage.findById(sent._id);
      expect(stored.media[0]).toMatchObject({ status: 'revoked' });
      expect(h.gateway.broadcastSavedMessage).toHaveBeenCalledWith(
        expect.objectContaining({ viewOnce: true, media: [expect.objectContaining({ status: 'revoked' })] }),
        'messageUpdated',
      );
      // History still shows that the photo was opened.
      const [row] = await h.chat.getChatHistory(alice, bob, { limit: 10 });
      expect(row).toMatchObject({ viewOnce: true, viewedAt: expect.any(Date) });
    });
  });
});
