import { HttpException } from '@nestjs/common';
import { DAILY_LIMIT_ERROR, GodChatQuotaService, nextUtcMidnight, utcDay } from './god-chat-quota.service';

const userId = '507f1f77bcf86cd799439011';
const now = new Date('2026-11-05T15:00:00Z');

/** In-memory stand-in for the Users and GodChatUsage collections. */
function setup(user: any, limit?: string) {
  const rows = new Map<string, any>();
  const usage = {
    createIndex: jest.fn(),
    findOne: jest.fn(async ({ _id }: any) => rows.get(_id) ?? null),
    updateOne: jest.fn(async (filter: any, update: any, options: any) => {
      const row = rows.get(filter._id);
      if (row) {
        if (row.count >= filter.count.$lt || row.ids.includes(filter.ids.$ne)) {
          if (options?.upsert) throw Object.assign(new Error('dup'), { code: 11000 });
          return { matchedCount: 0, upsertedCount: 0 };
        }
        row.count += update.$inc.count;
        row.ids.push(update.$push.ids);
        return { matchedCount: 1, upsertedCount: 0 };
      }
      rows.set(filter._id, { _id: filter._id, ...update.$setOnInsert, count: 1, ids: [update.$push.ids] });
      return { matchedCount: 0, upsertedCount: 1 };
    }),
  };
  const users = { findOne: jest.fn(async () => user) };
  const db: any = { db: { collection: (name: string) => (name === 'Users' ? users : usage) } };
  const config: any = { get: (key: string) => (key === 'GOD_CHAT_FREE_DAILY_MESSAGES' ? limit : undefined) };
  return { quota: new GodChatQuotaService(db, config), rows, usage };
}

async function limitCode(promise: Promise<unknown>) {
  try {
    await promise;
    return null;
  } catch (error) {
    return error instanceof HttpException ? [(error.getResponse() as any).error, error.getStatus()] : error;
  }
}

describe('God chat daily free messages', () => {
  it('uses UTC days', () => {
    expect(utcDay(now)).toBe('2026-11-05');
    expect(nextUtcMidnight(now).toISOString()).toBe('2026-11-06T00:00:00.000Z');
  });

  it('allows 10 free messages a day, then refuses with a stable error code', async () => {
    const { quota } = setup({ roles: ['user'] });
    for (let i = 0; i < 10; i++) await quota.consume(userId, `m${i}`, now);
    expect(await limitCode(quota.consume(userId, 'm10', now))).toEqual([DAILY_LIMIT_ERROR, 429]);
    expect(await quota.status(userId, now)).toEqual({
      unlimited: false, limit: 10, used: 10, remaining: 0, resetsAt: '2026-11-06T00:00:00.000Z',
    });
    // The next UTC day starts a fresh count.
    await quota.consume(userId, 'm11', new Date('2026-11-06T00:00:01Z'));
  });

  it('counts a retried message id once, even after the limit is reached', async () => {
    const { quota } = setup({ roles: ['user'] });
    await quota.consume(userId, 'same', now);
    await quota.consume(userId, 'same', now);
    expect((await quota.status(userId, now)).used).toBe(1);
    for (let i = 0; i < 9; i++) await quota.consume(userId, `m${i}`, now);
    await expect(quota.consume(userId, 'same', now)).resolves.toBeUndefined();
  });

  it('never limits premium members or staff', async () => {
    const premium = setup({ roles: ['user'], premiumUntil: new Date(Date.now() + 86_400_000) });
    const admin = setup({ roles: ['admin'] });
    for (const { quota, usage } of [premium, admin]) {
      for (let i = 0; i < 15; i++) await quota.consume(userId, `m${i}`, now);
      expect(usage.updateOne).not.toHaveBeenCalled();
      expect((await quota.status(userId, now)).unlimited).toBe(true);
    }
  });

  it('treats expired premium as free and honours a configured limit', async () => {
    const { quota } = setup({ roles: ['user'], premiumUntil: new Date(Date.now() - 1000) }, '2');
    await quota.consume(userId, 'a', now);
    await quota.consume(userId, 'b', now);
    expect(await limitCode(quota.consume(userId, 'c', now))).toEqual([DAILY_LIMIT_ERROR, 429]);
  });
});
