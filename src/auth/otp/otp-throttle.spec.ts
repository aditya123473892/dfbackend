import { ConfigService } from '@nestjs/config';
import { OtpThrottle } from './otp-throttle';

describe('OTP development rate-limit switch', () => {
  function setup(mode: string | undefined, enabled?: string) {
    const values: Record<string, string | undefined> = {
      NODE_ENV: mode,
      OTP_DEV_BYPASS_RATE_LIMITS: enabled,
    };
    const throttle = new OtpThrottle({ get: (key: string) => values[key] } as ConfigService, {} as any);
    throttle.store = {
      hit: jest.fn().mockResolvedValue(100),
      claim: jest.fn().mockResolvedValue(30),
    };
    return throttle;
  }

  it('bypasses stored counters and cooldowns only when explicitly enabled in development', async () => {
    const throttle = setup('development', 'true');
    await throttle.consume([{ key: 'test', limit: 1, windowSeconds: 600 }]);
    await throttle.cooldown('test');
    expect(throttle.store.hit).not.toHaveBeenCalled();
    expect(throttle.store.claim).not.toHaveBeenCalled();
    expect(throttle.limits.resendCooldownSeconds).toBe(0);
  });

  it.each([
    ['production', 'true'], ['test', 'true'], [undefined, 'true'],
    ['development', undefined], ['development', 'false'],
  ])('enforces limits for mode=%s and bypass=%s', async (mode, enabled) => {
    const throttle = setup(mode, enabled);
    await expect(throttle.consume([{ key: 'test', limit: 1, windowSeconds: 600 }])).rejects.toThrow();
    await expect(throttle.cooldown('test')).rejects.toThrow();
    expect(throttle.limits.resendCooldownSeconds).toBe(30);
  });
});
