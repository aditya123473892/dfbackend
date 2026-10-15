import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Types } from 'mongoose';
import { Harness, clientId } from './harness';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { normalize } = require('../../scripts/normalize-chat-ids');

describe('Chat (MongoDB integration)', () => {
  const h = new Harness();
  beforeAll(() => h.start());
  afterAll(() => h.stop());
  beforeEach(() => h.reset());

  it('persists a direct message once per clientId, including concurrent retries', async () => {
    const [alice, bob] = await h.users(2);
    const key = clientId();
    const sends = await Promise.all(
      Array.from({ length: 5 }, () =>
        h.chat.saveTextMessage({ sender: alice, receiver: bob, message: ' hi ', clientId: key }),
      ),
    );
    expect(new Set(sends.map((message) => String(message._id))).size).toBe(1);
    expect(sends[0]).toMatchObject({ message: 'hi', clientId: key });
    expect(await h.models.ChatMessage.countDocuments()).toBe(1);

    // A later retry (e.g. after reconnecting) returns the stored record.
    const retried = await h.chat.saveTextMessage({ sender: alice, receiver: bob, message: 'hi', clientId: key });
    expect(String(retried._id)).toBe(String(sends[0]._id));
  });

  it('rejects a clientId reused for a different conversation', async () => {
    const [alice, bob, carol] = await h.users(3);
    const key = clientId();
    await h.chat.saveTextMessage({ sender: alice, receiver: bob, message: 'one', clientId: key });
    await expect(
      h.chat.saveTextMessage({ sender: alice, receiver: carol, message: 'two', clientId: key }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('keeps one stored message for media sends retried with the same clientId', async () => {
    const [alice, bob] = await h.users(2);
    const key = clientId();
    const first = await h.chat.createMediaMessage(alice, { receiver: bob, message: 'text only', clientId: key }, []);
    const second = await h.chat.createMediaMessage(alice, { receiver: bob, message: 'text only', clientId: key }, []);
    expect(String(second._id)).toBe(String(first._id));
    expect(await h.models.ChatMessage.countDocuments()).toBe(1);
  });

  it('rejects empty, oversized and self-addressed messages', async () => {
    const [alice, bob] = await h.users(2);
    await expect(h.chat.saveTextMessage({ sender: alice, receiver: bob, message: '   ' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      h.chat.saveTextMessage({ sender: alice, receiver: bob, message: 'x'.repeat(10001) }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(h.chat.assertCanSendDirect(alice, alice)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('pages history newest-first by (sentAt, _id) without gaps or duplicates', async () => {
    const [alice, bob] = await h.users(2);
    const sameInstant = new Date('2026-10-01T10:00:00Z');
    // Several messages share one timestamp to exercise the tie-breaker.
    for (let index = 0; index < 7; index++) {
      await h.models.ChatMessage.create({
        sender: index % 2 ? alice : bob,
        receiver: index % 2 ? bob : alice,
        message: `m${index}`,
        sentAt: index < 5 ? sameInstant : new Date(sameInstant.getTime() + index * 1000),
      });
    }
    const seen: string[] = [];
    let page = await h.chat.getChatHistory(alice, bob, { limit: 3 });
    while (page.length) {
      expect(page.map((m: any) => +new Date(m.sentAt))).toEqual([...page.map((m: any) => +new Date(m.sentAt))].sort((a, b) => a - b));
      seen.unshift(...page.map((m: any) => m.message));
      if (page.length < 3) break;
      page = await h.chat.getChatHistory(alice, bob, { limit: 3, before: String(page[0]._id) });
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect(seen.slice(-2)).toEqual(['m5', 'm6']);

    // Legacy clients without a limit still receive the full ascending history.
    expect(await h.chat.getChatHistory(alice, bob)).toHaveLength(7);
  });

  it('stores concurrent messages from both sides and returns them in order', async () => {
    const [alice, bob] = await h.users(2);
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        h.chat.saveTextMessage({
          sender: index % 2 ? alice : bob,
          receiver: index % 2 ? bob : alice,
          message: `m${index}`,
          clientId: clientId(),
        }),
      ),
    );
    const history = await h.chat.getChatHistory(bob, alice, { limit: 100 });
    expect(history).toHaveLength(20);
    const times = history.map((m: any) => +new Date(m.sentAt));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('reports direct conversations with last message and unread counts, most recent first', async () => {
    const [me, bob, carol] = await h.users(3);
    await h.chat.saveTextMessage({ sender: bob, receiver: me, message: 'from bob 1' });
    await h.chat.saveTextMessage({ sender: bob, receiver: me, message: 'from bob 2' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await h.chat.saveTextMessage({ sender: me, receiver: carol, message: 'to carol' });

    let conversations = await h.chat.getConversations(me);
    expect(conversations.map((c) => c.id)).toEqual([`user:${carol}`, `user:${bob}`]);
    expect(conversations[1]).toMatchObject({ unreadCount: 2, lastMessage: { message: 'from bob 2' } });
    expect(conversations[0]).toMatchObject({ unreadCount: 0 });
    // Only public profile fields of peers are exposed.
    expect((conversations[1] as any).peer).not.toHaveProperty('username');

    await h.chat.markMessagesAsRead(me, bob);
    conversations = await h.chat.getConversations(me);
    expect(conversations.find((c) => c.id === `user:${bob}`).unreadCount).toBe(0);
    expect(await h.chat.getUnreadMessageCount(me)).toHaveLength(0);
  });

  it('tracks group unread counts per member with read cursors', async () => {
    const [owner, member, late] = await h.users(3);
    const group = await h.groups.createGroup({ name: 'Night owls', members: [member] }, owner);
    const groupId = String(group._id);

    await h.chat.saveTextMessage({ sender: owner, groupId, message: 'one', type: 'group' });
    await h.chat.saveTextMessage({ sender: owner, groupId, message: 'two', type: 'group' });

    const unreadFor = async (user: string) =>
      (await h.chat.getConversations(user)).find((c) => c.id === `group:${groupId}`).unreadCount;
    expect(await unreadFor(member)).toBe(2);
    expect(await unreadFor(owner)).toBe(0); // own messages never count

    await h.chat.markGroupAsRead(member, groupId);
    expect(await unreadFor(member)).toBe(0);

    // A member added later does not inherit the backlog as unread.
    await h.groups.addMembers({ groupId, members: [late] }, owner);
    expect(await unreadFor(late)).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await h.chat.saveTextMessage({ sender: member, groupId, message: 'three', type: 'group' });
    expect(await unreadFor(late)).toBe(1);
    expect(await unreadFor(owner)).toBe(1);
  });

  it('finds messages whose ids were stored as strings (older backend) or ObjectIds (imported)', async () => {
    const [me, bob] = await h.users(2);
    const raw = h.models.ChatMessage.collection;
    await raw.insertMany([
      { sender: bob, receiver: me, message: 'legacy string ids', isRead: false, sentAt: new Date(1000) },
      { sender: new Types.ObjectId(bob), receiver: new Types.ObjectId(me), message: 'imported', isRead: false, sentAt: new Date(2000) },
    ]);
    await h.chat.saveTextMessage({ sender: me, receiver: bob, message: 'new reply' });

    const history = await h.chat.getChatHistory(me, bob, { limit: 10 });
    expect(history.map((m: any) => m.message)).toEqual(['legacy string ids', 'imported', 'new reply']);
    const [conversation] = await h.chat.getConversations(me);
    expect(conversation).toMatchObject({ id: `user:${bob}`, unreadCount: 2, lastMessage: { message: 'new reply' } });
    expect(await h.chat.getUnreadMessageCount(me)).toHaveLength(2);

    await h.chat.markMessagesAsRead(me, bob);
    expect(await h.chat.getUnreadMessageCount(me)).toHaveLength(0);

    // The optional clean-up script converts the string ids; reads are unchanged.
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    await normalize(h.connection.db);
    expect(await raw.countDocuments({ sender: { $type: 'string' } })).toBe(0);
    expect(await h.chat.getChatHistory(me, bob, { limit: 10 })).toHaveLength(3);
  });

  it('blocks non-members from group history, sending and read cursors', async () => {
    const [owner, member, outsider] = await h.users(3);
    const group = await h.groups.createGroup({ name: 'Members only', members: [member] }, owner);
    const groupId = String(group._id);
    await expect(h.chat.getChatGroupHistory(outsider, groupId, { limit: 10 })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(h.chat.assertGroupMember(outsider, groupId)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(h.chat.markGroupAsRead(outsider, groupId)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      h.chat.createMediaMessage(outsider, { groupId, message: 'let me in' }, []),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // Group history exposes only public sender fields.
    await h.chat.saveTextMessage({ sender: owner, groupId, message: 'hello', type: 'group' });
    const [message] = await h.chat.getChatGroupHistory(member, groupId, { limit: 10 });
    expect(message.sender).toHaveProperty('displayname');
    expect(message.sender).not.toHaveProperty('username');
  });
});
