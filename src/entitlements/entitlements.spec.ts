import { DisabledEntitlementVerifier, EntitlementsService } from './entitlements.module';
import { assertLocalEntitlementDevelopment } from './dev-entitlement';

describe('Server entitlement boundaries', () => {
  const local = { NODE_ENV: 'development', DATABASE_URL: 'mongodb://127.0.0.1:27017', DATABASE_NAME: 'darkfantasy_test' };
  it('permits only local development test databases', () => {
    expect(() => assertLocalEntitlementDevelopment(local)).not.toThrow();
    for (const NODE_ENV of ['production', 'staging', 'test', ''])
      expect(() => assertLocalEntitlementDevelopment({ ...local, NODE_ENV })).toThrow();
    for (const DATABASE_URL of ['mongodb+srv://prod.example/', 'mongodb://prod.example/', 'mongodb://127.0.0.1,prod.example/', 'mongodb://127.0.0.1/?replicaSet=prod'])
      expect(() => assertLocalEntitlementDevelopment({ ...local, DATABASE_URL })).toThrow();
    expect(() => assertLocalEntitlementDevelopment({ ...local, DATABASE_NAME: 'production' })).toThrow();
  });
  it('keeps provider verification disabled', async () => {
    await expect(new DisabledEntitlementVerifier().verify(Buffer.from('{}'), 'unverified')).rejects.toThrow('not yet available');
  });
  it('reads the current persisted expiry every time', async () => {
    const findOne = jest.fn().mockResolvedValueOnce({ premiumUntil: new Date(Date.now() + 60000) })
      .mockResolvedValueOnce({ premiumUntil: new Date(Date.now() - 1) });
    const service = new EntitlementsService({ db: { collection: () => ({ findOne }) } } as any);
    expect((await service.status('507f1f77bcf86cd799439011')).active).toBe(true);
    expect((await service.status('507f1f77bcf86cd799439011')).active).toBe(false);
    expect(findOne).toHaveBeenCalledTimes(2);
  });
});
