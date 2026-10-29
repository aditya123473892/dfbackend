import { ConflictException } from '@nestjs/common';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { Connection, Types } from 'mongoose';
import { GodChatSessionsService } from 'src/god-chat/god-chat-sessions.service';
import { GodChatService } from 'src/god-chat/god-chat.service';
import { LlmClient } from 'src/god-chat/llm.client';

describe('God chat sessions (Mongo)', () => {
  let server: MongoMemoryServer;
  let connection: Connection;
  let sessions: GodChatSessionsService;
  let chat: GodChatService;
  const complete = jest.fn(async () => 'Seek the Events tab.');
  const member = new Types.ObjectId();
  const admin = new Types.ObjectId();
  const otherAdmin = new Types.ObjectId();

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    connection = await mongoose.createConnection(server.getUri(), { dbName: 'god-chat-test' }).asPromise();
    await connection.db.collection('Users').insertMany([
      { _id: member, username: 'wanderer', displayname: 'Wanderer' },
      { _id: admin, username: 'keeper', displayname: 'Keeper' },
    ]);
    sessions = new GodChatSessionsService(connection);
    await sessions.onModuleInit();
    chat = new GodChatService(
      { configured: true, complete } as unknown as LlmClient,
      { get: () => '100' } as any,
      sessions,
    );
  });
  afterAll(async () => {
    await connection?.close();
    await server?.stop();
  });

  it('lets an admin see, take over, answer and hand back a live session', async () => {
    const first = await chat.send(member.toHexString(), { id: 'msg-00001', content: 'how do events work' });
    expect(first.session!.messages.map((m) => m.by)).toEqual(['user', 'ai']);

    const listed = await sessions.list({ filter: 'live' });
    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0]).toMatchObject({ mode: 'ai', live: true, user: { username: 'wanderer' } });
    const id = String(listed.sessions[0]!._id);

    await expect(sessions.staffReply(admin.toHexString(), id, { id: 'staff-0001', content: 'hello' }))
      .rejects.toBeInstanceOf(ConflictException);
    const taken = await sessions.takeOver(admin.toHexString(), id);
    expect(taken).toMatchObject({ mode: 'staff', staff: { username: 'keeper' } });

    complete.mockClear();
    const waiting = await chat.send(member.toHexString(), { id: 'msg-00002', content: 'is anyone there?' });
    expect(complete).not.toHaveBeenCalled();
    expect(waiting.session!.mode).toBe('staff');

    await sessions.staffReply(admin.toHexString(), id, { id: 'staff-0001', content: 'Yes, I am here.' });
    await sessions.staffReply(admin.toHexString(), id, { id: 'staff-0001', content: 'Yes, I am here.' });
    const seen = await chat.session(member.toHexString());
    expect(seen.session!.messages.filter((m) => m.by === 'staff')).toHaveLength(1);
    expect(JSON.stringify(seen)).not.toContain(admin.toHexString());

    // A second admin can take it from the first; the first can no longer reply.
    await sessions.takeOver(otherAdmin.toHexString(), id);
    await expect(sessions.staffReply(admin.toHexString(), id, { id: 'staff-0002', content: 'still me' }))
      .rejects.toBeInstanceOf(ConflictException);

    await sessions.release(otherAdmin.toHexString(), id);
    const back = await chat.send(member.toHexString(), { id: 'msg-00003', content: 'thanks' });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(back.session!.mode).toBe('ai');
    expect(back.session!.messages.filter((m) => m.role === 'event')).toHaveLength(3);
  });

  it('picks up after a handoff with the team\'s replies in context and answers what was left waiting', async () => {
    const userId = new Types.ObjectId().toHexString();
    await chat.send(userId, { id: 'hand-0001', content: 'can I get a refund for premium?' });
    const id = (await chat.session(userId)).session!.id;
    await sessions.takeOver(admin.toHexString(), id);
    await sessions.staffReply(admin.toHexString(), id, { id: 'staff-1001', content: 'I refunded you; it lands in 5 days.' });
    await chat.send(userId, { id: 'hand-0002', content: 'great, and when does premium end?' });

    complete.mockClear();
    complete.mockResolvedValueOnce('Your premium ends when the refund lands.');
    const released = await sessions.release(admin.toHexString(), id);
    expect(released.mode).toBe('ai');
    const resumed = await chat.resume(released._id);
    expect(complete).toHaveBeenCalledTimes(1);
    const [messages] = complete.mock.calls[0] as unknown as [{ role: string; content: string }[]];
    expect(messages[0]!.content).toContain('HANDOFF:');
    // God's earlier answer and the team's reply are one assistant turn, the team's part marked.
    expect(messages.slice(1).map((m) => m.content)).toEqual([
      'can I get a refund for premium?',
      'Seek the Events tab.\n\n[Team member] I refunded you; it lands in 5 days.',
      'great, and when does premium end?',
    ]);
    expect(resumed!.messages.at(-1)).toMatchObject({ by: 'ai', content: 'Your premium ends when the refund lands.' });

    // Nothing is waiting any more, so resuming again (or a retry) does not answer twice.
    await chat.resume(released._id);
    await chat.send(userId, { id: 'hand-0002', content: 'great, and when does premium end?' });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('flags risky messages for admins, keeps closed chats as history and only shows members their own', async () => {
    const userId = new Types.ObjectId().toHexString();
    complete.mockClear();
    const first = await chat.send(userId, { id: 'flag-0001', content: 'my password is hunter22 and I feel suicidal' });
    expect(complete).not.toHaveBeenCalled();
    expect(first.session!.messages.map((m) => m.content)).toEqual([
      'my password is [removed] and I feel suicidal',
      expect.stringContaining('crisis line'),
    ]);
    expect(JSON.stringify(first)).not.toContain('self_harm');

    const flagged = await sessions.list({ filter: 'flagged' });
    const row = flagged.sessions.find((s) => String(s._id) === first.session!.id);
    expect(row).toMatchObject({ flagged: true, flags: expect.arrayContaining(['self_harm', 'sensitive_data']) });
    await sessions.markReviewed(admin.toHexString(), first.session!.id);
    expect((await sessions.list({ filter: 'flagged' })).sessions.some((s) => String(s._id) === first.session!.id)).toBe(false);

    await chat.newSession(userId);
    await chat.send(userId, { id: 'flag-0002', content: 'how do events work' });
    const history = await chat.history(userId, {});
    expect(history.sessions).toHaveLength(1);
    expect(history.sessions[0]).toMatchObject({ id: first.session!.id, messageCount: 2, preview: 'my password is [removed] and I feel suicidal' });
    const past = await chat.pastSession(userId, first.session!.id);
    expect(past.session).toMatchObject({ open: false, messages: [{ by: 'user' }, { by: 'ai' }] });
    await expect(chat.pastSession(member.toHexString(), first.session!.id)).rejects.toThrow('Session not found');

    const ended = await sessions.list({ filter: 'ended', userId });
    expect(ended.sessions.map((s) => String(s._id))).toEqual([first.session!.id]);
    expect((await sessions.list({ filter: 'all', userId })).sessions).toHaveLength(2);
  });

  it('does not duplicate a retried message and starts fresh after "new chat"', async () => {
    complete.mockClear();
    const userId = new Types.ObjectId().toHexString();
    complete.mockRejectedValueOnce(new Error('model down'));
    await expect(chat.send(userId, { id: 'retry-0001', content: 'hi' })).rejects.toThrow('model down');
    const retried = await chat.send(userId, { id: 'retry-0001', content: 'hi' });
    expect(retried.session!.messages.map((m) => m.by)).toEqual(['user', 'ai']);

    await chat.newSession(userId);
    expect((await chat.session(userId)).session).toBeNull();
    const fresh = await chat.send(userId, { id: 'retry-0002', content: 'again' });
    expect(fresh.session!.id).not.toBe(retried.session!.id);
  });
});
