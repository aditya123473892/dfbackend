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
