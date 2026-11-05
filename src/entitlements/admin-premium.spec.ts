import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { ROLES_KEY } from '../common/decorators';
import { ERole } from '../common/enums';
import {
  AdminPremiumService, LIFETIME_UNTIL, addMonths, memberListInput, nextPremiumUntil, parseMemberInput, premiumChangeInput,
} from './admin-premium.service';
import { AdminPremiumController } from './entitlements.module';

const userId = '507f1f77bcf86cd799439011';
function setup(user: any) {
  const audit: any[] = [];
  const users = {
    findOne: jest.fn(async () => user),
    updateOne: jest.fn(async (filter: any, update: any) => {
      if (!user || String(filter.premiumUntil ?? null) !== String(user.premiumUntil ?? null)) return { matchedCount: 0 };
      Object.assign(user, update.$set);
      return { matchedCount: 1 };
    }),
    find: jest.fn(() => ({ sort: () => ({ limit: () => ({ toArray: async () => (user ? [user] : []) }) }) })),
  };
  const db: any = { db: { collection: (name: string) => (name === 'AdminAuditLog' ? { insertOne: async (row: any) => audit.push(row) } : users) } };
  return { service: new AdminPremiumService(db), users, audit };
}

describe('admin premium membership', () => {
  it('is admin-only', () => {
    expect(Reflect.getMetadata(ROLES_KEY, AdminPremiumController)).toEqual([ERole.ADMIN]);
  });

  it('validates input strictly', () => {
    expect(parseMemberInput(premiumChangeInput, { premium: true, months: 3 })).toEqual({ premium: true, months: 3 });
    expect(parseMemberInput(premiumChangeInput, { premium: true, lifetime: true })).toEqual({ premium: true, lifetime: true });
    expect(parseMemberInput(premiumChangeInput, { premium: false })).toEqual({ premium: false });
    for (const bad of [{}, { premium: true }, { premium: true, months: 0 }, { premium: true, months: 1.5 },
      { premium: true, months: 121 }, { premium: false, months: 1 }, { premium: 'yes' }, { premium: true, months: 1, premiumUntil: '2099-01-01' }])
      expect(() => parseMemberInput(premiumChangeInput, bad)).toThrow(BadRequestException);
    expect(parseMemberInput(memberListInput, {})).toEqual({ filter: 'all' });
    expect(() => parseMemberInput(memberListInput, { filter: 'vip' })).toThrow(BadRequestException);
  });

  it('adds calendar months and clamps month ends', () => {
    expect(addMonths(new Date('2026-01-31T10:00:00Z'), 1).toISOString()).toBe('2026-02-28T10:00:00.000Z');
    expect(addMonths(new Date('2026-11-05T00:00:00Z'), 12).toISOString()).toBe('2027-11-05T00:00:00.000Z');
  });

  it('extends active premium instead of shortening it', () => {
    const now = new Date('2026-11-05T00:00:00Z');
    expect(nextPremiumUntil(null, { premium: true, months: 1 }, now)!.toISOString()).toBe('2026-12-05T00:00:00.000Z');
    expect(nextPremiumUntil('2026-01-01T00:00:00Z', { premium: true, months: 1 }, now)!.toISOString()).toBe('2026-12-05T00:00:00.000Z');
    expect(nextPremiumUntil('2027-03-01T00:00:00Z', { premium: true, months: 1 }, now)!.toISOString()).toBe('2027-04-01T00:00:00.000Z');
    expect(nextPremiumUntil(LIFETIME_UNTIL, { premium: true, months: 1 }, now)).toEqual(LIFETIME_UNTIL);
    expect(nextPremiumUntil(null, { premium: true, lifetime: true }, now)).toEqual(LIFETIME_UNTIL);
    expect(nextPremiumUntil('2027-03-01T00:00:00Z', { premium: false }, now)).toBeNull();
  });

  it('grants, revokes and audits every change', async () => {
    const user: any = { _id: new Types.ObjectId(userId), displayname: 'Ada', premiumUntil: null };
    const { service, audit } = setup(user);
    const granted = await service.setPremium('admin1', userId, { premium: true, months: 1 });
    expect(granted.premium).toBe(true);
    expect(user.premiumUntil.getTime()).toBeGreaterThan(Date.now());
    const lifetime = await service.setPremium('admin1', userId, { premium: true, lifetime: true });
    expect(lifetime.lifetime).toBe(true);
    const revoked = await service.setPremium('admin1', userId, { premium: false });
    expect(revoked.premium).toBe(false);
    expect(user.premiumUntil).toBeNull();
    expect(audit.map((row) => row.action)).toEqual(['premium:grant:1m', 'premium:grant:lifetime', 'premium:revoke']);
    expect(audit[0]).toMatchObject({ actorId: 'admin1', userId, previousPremiumUntil: null });
  });

  it('refuses unknown users and concurrent changes', async () => {
    await expect(setup(null).service.setPremium('admin1', 'nope', { premium: false })).rejects.toThrow(NotFoundException);
    await expect(setup(null).service.setPremium('admin1', userId, { premium: false })).rejects.toThrow(NotFoundException);
    const user: any = { _id: new Types.ObjectId(userId), premiumUntil: null };
    const { service, users, audit } = setup(user);
    users.updateOne.mockResolvedValueOnce({ matchedCount: 0 });
    await expect(service.setPremium('admin1', userId, { premium: true, months: 1 })).rejects.toThrow(ConflictException);
    expect(audit).toHaveLength(0);
  });

  it('lists members with only safe fields and premium state', async () => {
    const user: any = { _id: new Types.ObjectId(userId), displayname: 'Ada', username: 'a@x.com', premiumUntil: new Date(Date.now() + 1000), password: 'hash' };
    const { service, users } = setup(user);
    const result = await service.list({ filter: 'premium', search: 'a.d' });
    expect(result.users[0]).toMatchObject({ _id: userId, premium: true, lifetime: false });
    expect(result.users[0]).not.toHaveProperty('password');
    const [filter] = users.find.mock.calls[0] as any[];
    expect(JSON.stringify(filter)).toContain('premiumUntil');
    expect(String(filter.$and.at(-1).$or[0].displayname)).toBe('/a\\.d/i');
  });
});
