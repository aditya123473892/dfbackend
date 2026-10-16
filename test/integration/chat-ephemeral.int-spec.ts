import { BadRequestException, ForbiddenException, GoneException, NotFoundException } from '@nestjs/common';
import { ChatExpiryService } from 'src/chats/chat-expiry.service';
import { Harness, clientId } from './harness';

const jpeg = (): Express.Multer.File =>
  ({
    fieldname: 'media',
    originalname: 'photo.jpg',
    mimetype: 'image/jpeg',
    size: 16,
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1]),
  }) as Express.Multer.File;

describe('Disappearing and view-once messages (MongoDB integration)', () => {
  const h = new Harness();
  beforeAll(() => h.start());
  afterAll(() => h.stop());
  beforeEach(() => h.reset());

  const expire = (id: string) =>
    h.models.ChatMessage.updateOne({ _id: id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });

  describe('disappearing messages', () => {
    it('stores the expiry from an allowed timer and rejects other values', async () => {
      const [alice, bob] = await h.users(2);
      const before = Date.now();
      const sent = await h.chat.saveTextMessage({ sender: alice, receiver: bob, message: 'soon gone', ttlSeconds: 300 });
      const expiresAt = new Date(sent.expiresAt).getTime();
      expect(expiresAt - new Date(sent.sentAt).getTime()).toBe(300_000);
      expect(expiresAt).toBeGreaterThanOrEqual(before + 300_000);

      // Multipart bodies send the timer as a string.
      const viaRest = await h.chat.createMediaMessage(alice, { receiver: bob, message: 'rest', ttlSeconds: '30' }, []);
      expect(new Date(viaRest.expiresAt).getTime() - new Date(viaRest.sentAt).getTime()).toBe(30_000);

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
      await expect(h.chat.updateMessage(String(timed._id), alice, 'edit')).rejects.toBeInstanceOf(NotFoundException);
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

    it('sweeper deletes expired messages and their media, and broadcasts each deletion', async () => {
      const [alice, bob] = await h.users(2);
      const timed = await h.chat.createMediaMessage(alice, { receiver: bob, ttlSeconds: 30 }, [jpeg()]);
      const kept = await h.chat.saveTextMessage({ sender: alice, receiver: bob, message: 'kept', ttlSeconds: 3600 });
      await expire(timed._id);

      const sweeper = new ChatExpiryService(h.chat, h.gateway as any);
      await sweeper.sweep();

      expect(await h.models.ChatMessage.exists({ _id: timed._id })).toBeNull();
      expect(await h.models.ChatMessage.exists({ _id: kept._id })).not.toBeNull();
      expect(h.s3.deleteOne).toHaveBeenCalledWith(expect.stringMatching(/^chat-media\/.+\.jpg$/));
      expect(h.gateway.broadcastSavedMessage).toHaveBeenCalledTimes(1);
      expect(h.gateway.broadcastSavedMessage).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: String(timed._id) }),
        'messageDeleted',
      );
    });
  });

  describe('view-once media', () => {
    it('accepts exactly one attachment in a direct chat and nothing else', async () => {
      const [alice, bob, carol] = await h.users(3);
      const group = await h.groups.createGroup({ name: 'g', members: [bob], clientId: clientId() } as any, alice);
      const cases: [any, Express.Multer.File[]][] = [
        [{ receiver: bob, viewOnce: true }, []],
        [{ receiver: bob, viewOnce: true }, [jpeg(), jpeg()]],
        [{ receiver: bob, viewOnce: 'true', message: 'caption' }, [jpeg()]],
        [{ groupId: String(group._id), viewOnce: true }, [jpeg()]],
        [{ receiver: carol, viewOnce: 'yes' }, [jpeg()]],
      ];
      for (const [dto, files] of cases) {
        await expect(h.chat.createMediaMessage(alice, dto, files)).rejects.toBeInstanceOf(BadRequestException);
      }
      expect(h.s3.uploadPrivateFile).not.toHaveBeenCalled();

      const sent = await h.chat.createMediaMessage(alice, { receiver: bob, viewOnce: 'true' }, [jpeg()]);
      expect(sent.viewOnce).toBe(true);
      // Unopened view-once media is removed after 14 days.
      expect(new Date(sent.expiresAt).getTime() - new Date(sent.sentAt).getTime()).toBe(14 * 86400_000);
    });

    it('lets only the recipient open it, exactly once, even under concurrent requests', async () => {
      const [alice, bob, carol] = await h.users(3);
      const sent = await h.chat.createMediaMessage(alice, { receiver: bob, viewOnce: true }, [jpeg()]);
      const mediaId = String(sent.media[0]._id);

      await expect(h.chat.getMediaAccessUrl(alice, String(sent._id), mediaId)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(h.chat.getMediaAccessUrl(carol, String(sent._id), mediaId)).rejects.toBeInstanceOf(NotFoundException);

      const attempts = await Promise.allSettled(
        Array.from({ length: 5 }, () => h.chat.getMediaAccessUrl(bob, String(sent._id), mediaId)),
      );
      const opened = attempts.filter((a) => a.status === 'fulfilled') as PromiseFulfilledResult<any>[];
      expect(opened).toHaveLength(1);
      expect(opened[0].value).toMatchObject({ url: expect.any(String), viewOnce: true });
      expect(opened[0].value.message.viewedAt).toBeInstanceOf(Date);
      expect(attempts.filter((a) => a.status === 'rejected').every((a: any) => a.reason instanceof GoneException)).toBe(true);
      expect(h.s3.getSignedURL).toHaveBeenCalledTimes(1);

      await expect(h.chat.getMediaAccessUrl(bob, String(sent._id), mediaId)).rejects.toBeInstanceOf(GoneException);
      expect(await h.models.ChatMediaAudit.countDocuments({ action: 'media_view_once_opened' })).toBe(1);
    });

    it('keeps the item unopened when the URL cannot be signed', async () => {
      const [alice, bob] = await h.users(2);
      const sent = await h.chat.createMediaMessage(alice, { receiver: bob, viewOnce: true }, [jpeg()]);
      const mediaId = String(sent.media[0]._id);
      h.s3.getSignedURL.mockResolvedValueOnce(null as any);
      await expect(h.chat.getMediaAccessUrl(bob, String(sent._id), mediaId)).rejects.toBeInstanceOf(NotFoundException);
      expect((await h.models.ChatMessage.findById(sent._id)).viewedAt).toBeUndefined();
      await expect(h.chat.getMediaAccessUrl(bob, String(sent._id), mediaId)).resolves.toMatchObject({ viewOnce: true });
    });

    it('is excluded from the media gallery', async () => {
      const [alice, bob] = await h.users(2);
      await h.chat.createMediaMessage(alice, { receiver: bob, viewOnce: true }, [jpeg()]);
      const normal = await h.chat.createMediaMessage(alice, { receiver: bob }, [jpeg()]);
      const gallery = await h.chat.listConversationMedia(bob, { receiver: alice });
      expect(gallery.map((item) => String(item.messageId))).toEqual([String(normal._id)]);
    });

    it('sweeper deletes the stored file after the access URL lifetime and marks the media revoked', async () => {
      const [alice, bob] = await h.users(2);
      const sent = await h.chat.createMediaMessage(alice, { receiver: bob, viewOnce: true }, [jpeg()]);
      const mediaId = String(sent.media[0]._id);
      await h.chat.getMediaAccessUrl(bob, String(sent._id), mediaId);

      const sweeper = new ChatExpiryService(h.chat, h.gateway as any);
      await sweeper.sweep(); // still inside the URL lifetime: nothing removed
      expect(h.s3.deleteOne).not.toHaveBeenCalled();

      await sweeper.sweep(new Date(Date.now() + 301_000));
      expect(h.s3.deleteOne).toHaveBeenCalledTimes(1);
      const stored = await h.models.ChatMessage.findById(sent._id).select('+media.storageKey');
      expect(stored.media[0]).toMatchObject({ status: 'revoked' });
      expect(stored.media[0].storageKey).toBeUndefined();
      expect(h.gateway.broadcastSavedMessage).toHaveBeenCalledWith(
        expect.objectContaining({ viewOnce: true, media: [expect.objectContaining({ status: 'revoked' })] }),
        'messageUpdated',
      );
      // History still shows that a view-once item was opened.
      const [row] = await h.chat.getChatHistory(alice, bob, { limit: 10 });
      expect(row).toMatchObject({ viewOnce: true, viewedAt: expect.any(Date) });
    });
  });
});
