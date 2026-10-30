import { INestApplication, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { getConnectionToken } from '@nestjs/mongoose';
import { PassportModule } from '@nestjs/passport';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { hash } from 'bcrypt';
import { Types } from 'mongoose';
import request = require('supertest');
import { AuthController } from '../auth.controller';
import { AuthService } from '../auth.service';
import { UsersService } from 'src/users/users.service';
import { MailService } from 'src/mail/mail.service';
import { JwtStrategy, OtpSessionGuard } from 'src/common/guards';
import { GlobalExceptionFilter, ResponseInterceptor } from 'src/common/interceptors';
import { applicationValidationPipe } from 'src/common/validation';
import { OtpController } from './otp.controller';
import { OtpService } from './otp.service';
import { MemoryThrottleStore, OtpThrottle } from './otp-throttle';
import { ScopedTokens } from './scoped-token';
import { TwilioVerifyClient } from './twilio-verify.client';
import { PhoneLinkGuard } from './phone-link.guard';
import { maskPhone, normalizePhone } from './phone';

const SECRET = 'test-jwt-secret-that-is-long-enough-123';
const MOBILE = { 'X-Client-Platform': 'mobile' };
const PHONE = '+919876543210';
const OTHER_PHONE = '+919812345678';

type FakeUser = Record<string, any> & { _id: Types.ObjectId };

describe('Phone OTP authentication', () => {
  let app: INestApplication;
  let users: FakeUser[];
  let twilioSend: jest.Mock;
  let twilioCheck: jest.Mock;
  let throttle: OtpThrottle;
  let clock: number;
  let jwt: JwtService;
  let passwordHash: string;

  const user = (fields: Partial<FakeUser>): FakeUser => {
    const row = {
      _id: new Types.ObjectId(),
      username: `${Math.random().toString(36).slice(2)}@example.test`,
      password: passwordHash,
      firstName: 'Test',
      roles: ['user'],
      isEmailVerified: true,
      isBlocked: false,
      ...fields,
    };
    users.push(row);
    return row;
  };
  const byId = (id: unknown) => users.find((row) => String(row._id) === String(id)) ?? null;

  const usersService = {
    findByUsername: async (username: string) => users.find((row) => row.username === username) ?? null,
    // A fresh document per read, as from MongoDB (validateUser blanks its password).
    findOneWithPassword: async (username: string) => {
      const row = users.find((candidate) => candidate.username === username);
      return row ? {
        _id: row._id, username: row.username, password: row.password, roles: row.roles,
        isBlocked: row.isBlocked, moderationSuspendedUntil: row.moderationSuspendedUntil,
        deletionRequestedAt: row.deletionRequestedAt,
      } : null;
    },
    findByVerifiedPhone: async (phone: string) =>
      users.find((row) => row.phoneE164 === phone && row.phoneVerifiedAt) ?? null,
    phoneOwnerId: async (phone: string) => {
      const owner = users.find((row) => row.phoneE164 === phone);
      return owner ? String(owner._id) : null;
    },
    setVerifiedPhone: async (id: string, phone: string) => {
      const owner = users.find((row) => row.phoneE164 === phone);
      if (owner && String(owner._id) !== String(id)) return false;
      Object.assign(byId(id), { phoneE164: phone, phoneVerifiedAt: new Date() });
      return true;
    },
    create: async (dto: any) => user({ ...dto }),
    updateOne: async (id: string, fields: any) => Object.assign(byId(id), fields),
    findOne: async ({ _id }: any) => byId(_id),
    findById: async (id: string) => byId(id),
    updateLoginInfo: async () => undefined,
  };

  const db: any = {
    db: {
      collection: (name: string) => ({
        findOne: async (filter: any) => {
          if (name !== 'Users') return null;
          const row = byId(filter._id);
          return row && !row.isBlocked && !row.deletionRequestedAt ? row : null;
        },
      }),
    },
  };

  const claims = (token: string) => jwt.decode(token) as Record<string, any>;
  const send = (body: object, headers: Record<string, string> = MOBILE) =>
    request(app.getHttpServer()).post('/auth/otp/send').set(headers).send(body);
  const verify = (body: object) =>
    request(app.getHttpServer()).post('/auth/otp/verify').set(MOBILE).send(body);
  const advance = (seconds: number) => (clock += seconds * 1000);

  beforeAll(async () => {
    passwordHash = await hash('Correct1pass', 4);
  });

  beforeEach(async () => {
    users = [];
    clock = Date.UTC(2026, 0, 1, 12, 0, 0);
    twilioSend = jest.fn().mockResolvedValue({ status: 'pending' });
    twilioCheck = jest.fn().mockResolvedValue({ status: 'approved' });
    const config = new ConfigService({
      JWT_SECRET: SECRET,
      TWILIO_ACCOUNT_SID: `AC${'0'.repeat(32)}`,
      TWILIO_AUTH_TOKEN: 'test-auth-token',
      TWILIO_VERIFY_SERVICE_SID: `VA${'0'.repeat(32)}`,
    });
    const moduleRef = await Test.createTestingModule({
      imports: [PassportModule, JwtModule.register({ secret: SECRET, signOptions: { expiresIn: '1h' } })],
      controllers: [AuthController, OtpController],
      providers: [
        AuthService,
        OtpService,
        OtpThrottle,
        ScopedTokens,
        TwilioVerifyClient,
        PhoneLinkGuard,
        JwtStrategy,
        { provide: ConfigService, useValue: config },
        { provide: UsersService, useValue: usersService },
        { provide: MailService, useValue: { verifyAccount: jest.fn().mockResolvedValue({}) } },
        { provide: getConnectionToken(), useValue: db },
        { provide: APP_FILTER, useClass: GlobalExceptionFilter },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useGlobalPipes(applicationValidationPipe());
    await app.init();

    jwt = moduleRef.get(JwtService);
    throttle = moduleRef.get(OtpThrottle);
    throttle.store = new MemoryThrottleStore();
    throttle.now = () => clock;
    // Only the network boundary is faked; error mapping and masking stay real.
    (moduleRef.get(TwilioVerifyClient) as any).client = {
      verify: {
        v2: {
          services: () => ({
            verifications: { create: twilioSend },
            verificationChecks: { create: twilioCheck },
          }),
        },
      },
    };
  });

  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
    delete process.env.MOBILE_OTP_ONLY_ROUTES;
  });

  describe('POST /auth/otp/send', () => {
    it('normalises a national number to E.164 (+91 default) and sends an SMS', async () => {
      user({ phoneE164: PHONE, phoneVerifiedAt: new Date() });
      const res = await send({ phone: '98765 43210' }).expect(201);
      expect(res.body.data).toEqual({ resendAfterSeconds: 30 });
      expect(twilioSend).toHaveBeenCalledWith({ to: PHONE, channel: 'sms' });
    });

    it('answers an unregistered number identically without sending an SMS', async () => {
      user({ phoneE164: PHONE, phoneVerifiedAt: new Date() });
      const registered = await send({ phone: PHONE }).expect(201);
      const unknown = await send({ phone: OTHER_PHONE }).expect(201);
      expect(unknown.body.data).toEqual(registered.body.data);
      expect(unknown.body.message).toBe(registered.body.message);
      expect(twilioSend).toHaveBeenCalledTimes(1);
    });

    it('rejects an invalid number before calling Twilio', async () => {
      const res = await send({ phone: '12345' }).expect(400);
      expect(res.body.error).toBe('PHONE_INVALID');
      expect(twilioSend).not.toHaveBeenCalled();
    });

    it('enforces the resend cooldown, then the per-phone 10-minute cap', async () => {
      user({ phoneE164: PHONE, phoneVerifiedAt: new Date() });
      await send({ phone: PHONE }).expect(201);
      expect((await send({ phone: PHONE }).expect(429)).body.error).toBe('OTP_COOLDOWN');
      advance(31);
      await send({ phone: PHONE }).expect(201);
      advance(31);
      await send({ phone: PHONE }).expect(201);
      advance(31);
      expect((await send({ phone: PHONE }).expect(429)).body.error).toBe('OTP_SEND_LIMIT');
      expect(twilioSend).toHaveBeenCalledTimes(3);
    });

    it('caps sends per phone per day across 10-minute windows', async () => {
      for (let i = 0; i < 10; i++) {
        await send({ phone: PHONE, purpose: 'signup' }).expect(201);
        advance(10 * 60);
      }
      expect((await send({ phone: PHONE, purpose: 'signup' }).expect(429)).body.error).toBe('OTP_SEND_LIMIT');
    });

    it('caps sends per IP across different numbers', async () => {
      for (let i = 0; i < 10; i++)
        await send({ phone: `+9198765432${String(i).padStart(2, '0')}`, purpose: 'signup' }).expect(201);
      const res = await send({ phone: '+919876543299', purpose: 'signup' }).expect(429);
      expect(res.body.error).toBe('OTP_RATE_LIMITED');
    });

    it('maps Twilio errors on signup sends and masks the number in logs', async () => {
      const warn = jest.spyOn(Logger, 'warn').mockImplementation(() => undefined);
      twilioSend.mockRejectedValueOnce(Object.assign(new Error('Invalid parameter'), { status: 400, code: 60200 }));
      expect((await send({ phone: PHONE, purpose: 'signup' }).expect(400)).body.error).toBe('PHONE_INVALID');
      advance(31);
      twilioSend.mockRejectedValueOnce(Object.assign(new Error('Too many'), { status: 429, code: 60203 }));
      expect((await send({ phone: PHONE, purpose: 'signup' }).expect(429)).body.error).toBe('OTP_SEND_LIMIT');
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).toContain(maskPhone(PHONE));
      expect(logged).not.toContain(PHONE);
      expect(logged).not.toContain('test-auth-token');
    });

    it('hides Twilio errors for login sends so registration is not revealed', async () => {
      jest.spyOn(Logger, 'warn').mockImplementation(() => undefined);
      user({ phoneE164: PHONE, phoneVerifiedAt: new Date() });
      twilioSend.mockRejectedValueOnce(Object.assign(new Error('Too many'), { status: 429, code: 60203 }));
      await send({ phone: PHONE }).expect(201);
    });
  });

  describe('POST /auth/otp/verify', () => {
    it('issues the usual { user, accessToken } with auth_method "otp" on approval', async () => {
      const owner = user({ phoneE164: PHONE, phoneVerifiedAt: new Date() });
      const res = await verify({ phone: PHONE, code: '123456' }).expect(201);
      expect(res.body.data.user._id).toBe(String(owner._id));
      expect(claims(res.body.data.accessToken)).toMatchObject({ sub: String(owner._id), auth_method: 'otp' });
      expect(twilioCheck).toHaveBeenCalledWith({ to: PHONE, code: '123456' });
    });

    it('rejects a wrong code', async () => {
      user({ phoneE164: PHONE, phoneVerifiedAt: new Date() });
      twilioCheck.mockResolvedValueOnce({ status: 'pending' });
      const res = await verify({ phone: PHONE, code: '000000' }).expect(400);
      expect(res.body.error).toBe('OTP_INVALID');
      expect(res.body.data).toBeUndefined();
    });

    it('rejects an expired code (Twilio 20404) and too many wrong codes (60202)', async () => {
      jest.spyOn(Logger, 'warn').mockImplementation(() => undefined);
      user({ phoneE164: PHONE, phoneVerifiedAt: new Date() });
      twilioCheck.mockRejectedValueOnce(Object.assign(new Error('Not found'), { status: 404, code: 20404 }));
      expect((await verify({ phone: PHONE, code: '123456' }).expect(400)).body.error).toBe('OTP_EXPIRED');
      twilioCheck.mockRejectedValueOnce(Object.assign(new Error('Max'), { status: 429, code: 60202 }));
      expect((await verify({ phone: PHONE, code: '123456' }).expect(429)).body.error).toBe('OTP_CHECK_LIMIT');
    });

    it('treats an unregistered number like an expired code without calling Twilio', async () => {
      const res = await verify({ phone: OTHER_PHONE, code: '123456' }).expect(400);
      expect(res.body.error).toBe('OTP_EXPIRED');
      expect(twilioCheck).not.toHaveBeenCalled();
    });

    it('rate-limits verification attempts per phone', async () => {
      user({ phoneE164: PHONE, phoneVerifiedAt: new Date() });
      twilioCheck.mockResolvedValue({ status: 'pending' });
      for (let i = 0; i < 10; i++) await verify({ phone: PHONE, code: '000000' }).expect(400);
      expect((await verify({ phone: PHONE, code: '000000' }).expect(429)).body.error).toBe('OTP_RATE_LIMITED');
      expect(twilioCheck).toHaveBeenCalledTimes(10);
    });

    it('keeps the existing account checks (unverified email, blocked)', async () => {
      user({ phoneE164: PHONE, phoneVerifiedAt: new Date(), isEmailVerified: false });
      const res = await verify({ phone: PHONE, code: '123456' }).expect(400);
      expect(res.body.message).toBe("Your account isn't verified yet, Please check your email.");
      expect(res.body.data).toBeUndefined();
    });

    it('validates the code format', async () => {
      await verify({ phone: PHONE, code: 'abc' }).expect(400);
      expect(twilioCheck).not.toHaveBeenCalled();
    });
  });

  describe('mobile authentication', () => {
    const passwordLogin = (identifier: string, password = 'Correct1pass') =>
      request(app.getHttpServer()).post('/auth/password/login').set(MOBILE).send({ identifier, password });

    it('signs in with email or verified phone and marks password sessions accurately', async () => {
      const owner = user({ username: 'member@example.test', phoneE164: PHONE, phoneVerifiedAt: new Date() });
      for (const identifier of [' MEMBER@EXAMPLE.TEST ', PHONE, '98765 43210']) {
        const res = await passwordLogin(identifier).expect(201);
        expect(claims(res.body.data.accessToken)).toMatchObject({ sub: String(owner._id), auth_method: 'password' });
        await request(app.getHttpServer()).get('/auth/me').set(MOBILE)
          .set('Authorization', `Bearer ${res.body.data.accessToken}`).expect(200);
      }
    });

    it('rejects wrong passwords, unknown identities, blocked and deleted users', async () => {
      const owner = user({ username: 'member@example.test', phoneE164: PHONE, phoneVerifiedAt: new Date() });
      await passwordLogin(owner.username, 'wrong').expect(401);
      await passwordLogin('unknown@example.test').expect(401);
      await passwordLogin(OTHER_PHONE).expect(401);
      owner.isBlocked = true;
      await passwordLogin(owner.username).expect(401);
      owner.isBlocked = false;
      owner.deletionRequestedAt = new Date();
      await passwordLogin(PHONE).expect(401);
    });

    it('rate limits repeated password attempts', async () => {
      for (let i = 0; i < 10; i++) await passwordLogin('unknown@example.test', 'wrong').expect(401);
      await passwordLogin('unknown@example.test', 'wrong').expect(429);
    });
    it('rejects password login and password signup from the mobile app', async () => {
      const owner = user({});
      const login = await request(app.getHttpServer())
        .post('/auth/login').set(MOBILE).send({ username: owner.username, password: 'Correct1pass' }).expect(403);
      expect(login.body.error).toBe('PHONE_LOGIN_REQUIRED');
      expect(login.body.accessToken).toBeUndefined();
      const signup = await request(app.getHttpServer())
        .post('/auth/signup').set(MOBILE).send({ username: 'new@example.test', password: 'x', firstName: 'a', lastName: 'b', age: 30, gender: 'f', roles: ['user'] })
        .expect(403);
      expect(signup.body.error).toBe('PHONE_LOGIN_REQUIRED');
    });

    it('leaves web password login unchanged (token marked auth_method "password")', async () => {
      const owner = user({});
      const res = await request(app.getHttpServer())
        .post('/auth/login').send({ username: owner.username, password: 'Correct1pass' }).expect(201);
      expect(claims(res.body.data.accessToken)).toMatchObject({ auth_method: 'password' });
      await request(app.getHttpServer())
        .get('/auth/me').set('Authorization', `Bearer ${res.body.data.accessToken}`).expect(200);
    });

    it('accepts password and OTP sessions on mobile but rejects legacy unmarked tokens', async () => {
      const owner = user({ phoneE164: PHONE, phoneVerifiedAt: new Date() });
      const web = await new AuthService(usersService as any, jwt).createTokens(owner);
      const legacy = jwt.sign({ sub: String(owner._id), roles: owner.roles }); // issued before OTP
      await request(app.getHttpServer()).get('/auth/me').set(MOBILE).set('Authorization', `Bearer ${legacy}`).expect(401);
      await request(app.getHttpServer()).get('/auth/me').set(MOBILE).set('Authorization', `Bearer ${web.accessToken}`).expect(200);
      const otp = (await verify({ phone: PHONE, code: '123456' })).body.data.accessToken;
      await request(app.getHttpServer()).get('/auth/me').set(MOBILE).set('Authorization', `Bearer ${otp}`).expect(200);
    });

    it('guards mobile-only routes with OtpSessionGuard when enabled', () => {
      const guard = new OtpSessionGuard();
      const ctx = (authMethod: string) =>
        ({ switchToHttp: () => ({ getRequest: () => ({ user: { authMethod } }) }) }) as any;
      expect(guard.canActivate(ctx('password'))).toBe(true); // off by default for older builds
      process.env.MOBILE_OTP_ONLY_ROUTES = 'on';
      expect(() => guard.canActivate(ctx('password'))).toThrow('phone number');
      expect(guard.canActivate(ctx('otp'))).toBe(true);
    });
  });

  describe('existing-user bootstrap', () => {
    const bootstrap = (username: string, password = 'Correct1pass') =>
      request(app.getHttpServer()).post('/auth/phone/bootstrap').set(MOBILE).send({ username, password });

    it('signs in once with the password, links a verified phone, then uses OTP only', async () => {
      const existing = user({});
      const start = await bootstrap(existing.username).expect(201);
      const bootstrapToken = start.body.data.bootstrapToken;
      expect(start.body.data.accessToken).toBeUndefined();

      // The bootstrap token is not a session anywhere else.
      await request(app.getHttpServer()).get('/auth/me').set('Authorization', `Bearer ${bootstrapToken}`).expect(401);

      await request(app.getHttpServer())
        .post('/auth/phone/send').set(MOBILE).set('Authorization', `Bearer ${bootstrapToken}`).send({ phone: PHONE }).expect(201);
      expect(twilioSend).toHaveBeenCalledWith({ to: PHONE, channel: 'sms' });
      const linked = await request(app.getHttpServer())
        .post('/auth/phone/verify').set(MOBILE).set('Authorization', `Bearer ${bootstrapToken}`)
        .send({ phone: PHONE, code: '123456' }).expect(201);
      expect(claims(linked.body.data.accessToken)).toMatchObject({ sub: String(existing._id), auth_method: 'otp' });
      expect(existing.phoneE164).toBe(PHONE);
      expect(existing.phoneVerifiedAt).toBeInstanceOf(Date);

      expect((await bootstrap(existing.username).expect(409)).body.error).toBe('PHONE_ALREADY_LINKED');
      await verify({ phone: PHONE, code: '123456' }).expect(201);
    });

    it('rejects a wrong password with the generic 401', async () => {
      const existing = user({});
      await bootstrap(existing.username, 'Wrong1pass').expect(401);
      await bootstrap('missing@example.test').expect(401);
    });

    it('rejects a phone already verified by another account', async () => {
      user({ phoneE164: PHONE, phoneVerifiedAt: new Date() });
      const existing = user({});
      const token = (await bootstrap(existing.username)).body.data.bootstrapToken;
      const res = await request(app.getHttpServer())
        .post('/auth/phone/verify').set(MOBILE).set('Authorization', `Bearer ${token}`)
        .send({ phone: PHONE, code: '123456' }).expect(409);
      expect(res.body.error).toBe('PHONE_IN_USE');
      expect(existing.phoneE164).toBeUndefined();
    });

    it('requires a fresh OTP to change the phone later', async () => {
      const owner = user({ phoneE164: PHONE, phoneVerifiedAt: new Date() });
      const session = (await verify({ phone: PHONE, code: '123456' })).body.data.accessToken;
      twilioCheck.mockResolvedValueOnce({ status: 'pending' });
      await request(app.getHttpServer())
        .post('/auth/phone/verify').set(MOBILE).set('Authorization', `Bearer ${session}`)
        .send({ phone: OTHER_PHONE, code: '000000' }).expect(400);
      expect(owner.phoneE164).toBe(PHONE);
      const changed = await request(app.getHttpServer())
        .post('/auth/phone/verify').set(MOBILE).set('Authorization', `Bearer ${session}`)
        .send({ phone: OTHER_PHONE, code: '123456' }).expect(201);
      expect(owner.phoneE164).toBe(OTHER_PHONE);
      expect(changed.body.data.accessToken).toBeUndefined();
    });

    it('lets web users add a phone with their normal session', async () => {
      const owner = user({});
      const web = (await request(app.getHttpServer())
        .post('/auth/login').send({ username: owner.username, password: 'Correct1pass' })).body.data.accessToken;
      await request(app.getHttpServer())
        .post('/auth/phone/verify').set('Authorization', `Bearer ${web}`).send({ phone: PHONE, code: '123456' }).expect(201);
      expect(owner.phoneE164).toBe(PHONE);
    });
  });

  describe('new signup', () => {
    const profile = { username: 'new@example.test', password: 'Correct1pass', firstName: 'New', lastName: 'User', age: 30, gender: 'female' };

    it('creates an account with only email, password and a verified phone proof', async () => {
      const proof = await request(app.getHttpServer()).post('/auth/otp/signup/verify')
        .send({ phone: PHONE, code: '123456' }).expect(201);
      const signupToken = proof.body.data.signupToken;
      await request(app.getHttpServer()).post('/auth/otp/signup')
        .send({ username: 'MINIMAL@example.test', password: 'weak', signupToken }).expect(400);
      const created = await request(app.getHttpServer()).post('/auth/otp/signup')
        .send({ username: 'MINIMAL@example.test', password: 'Correct1pass', signupToken }).expect(201);
      expect(created.body.data.user.username).toBe('minimal@example.test');
      expect(created.body.data.user.phoneE164).toBe(PHONE);
      expect(created.body.data.user.displayname).toMatch(/^member_/);
      await request(app.getHttpServer()).post('/auth/otp/signup')
        .send({ username: 'other@example.test', password: 'Correct1pass', signupToken }).expect(409);
    });

    it('verifies the phone, then creates the account with it', async () => {
      await send({ phone: PHONE, purpose: 'signup' }).expect(201);
      const proof = await request(app.getHttpServer())
        .post('/auth/otp/signup/verify').set(MOBILE).send({ phone: PHONE, code: '123456' }).expect(201);
      const created = await request(app.getHttpServer())
        .post('/auth/otp/signup').set(MOBILE).send({ ...profile, signupToken: proof.body.data.signupToken }).expect(201);
      const row = users.find((u) => u.username === profile.username)!;
      expect(row).toMatchObject({ phoneE164: PHONE, roles: ['user'] });
      expect(row.phoneVerifiedAt).toBeInstanceOf(Date);
      // Development mail mock verifies the email, so the account signs straight in.
      expect(claims(created.body.data.accessToken)).toMatchObject({ auth_method: 'otp' });
    });

    it('rejects a phone verified by another user and a forged signup token', async () => {
      user({ phoneE164: PHONE, phoneVerifiedAt: new Date() });
      expect((await request(app.getHttpServer())
        .post('/auth/otp/signup/verify').send({ phone: PHONE, code: '123456' }).expect(409)).body.error).toBe('PHONE_IN_USE');
      const forged = jwt.sign({ scope: 'phone_signup', phone: OTHER_PHONE }); // session key, not the scoped key
      expect((await request(app.getHttpServer())
        .post('/auth/otp/signup').send({ ...profile, signupToken: forged }).expect(400)).body.error).toBe('SIGNUP_SESSION_INVALID');
    });
  });
});

describe('phone helpers', () => {
  it('normalises common formats and rejects junk', () => {
    expect(normalizePhone('09876543210')).toBe(PHONE);
    expect(normalizePhone('+91 98765-43210')).toBe(PHONE);
    expect(normalizePhone('0044 7400 123456')).toBe('+447400123456');
    expect(normalizePhone('(415) 555-2671', 'US')).toBe('+14155552671');
    expect(normalizePhone('not a phone')).toBeNull();
    expect(normalizePhone({} as any)).toBeNull();
  });

  it('masks numbers for logs', () => {
    expect(maskPhone(PHONE)).toBe('+91********10');
  });
});
