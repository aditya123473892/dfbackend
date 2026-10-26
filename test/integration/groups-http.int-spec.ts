import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { getConnectionToken } from '@nestjs/mongoose';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { GroupController } from 'src/group-chat/group.controller';
import { GroupService } from 'src/group-chat/group.service';
import { JwtStrategy } from 'src/common/guards/jwt.strategy';
import { GlobalExceptionFilter, ResponseInterceptor } from 'src/common/interceptors';
import { applicationValidationPipe } from 'src/common/validation';
import { PhotoResponseInterceptor } from 'src/photos/response.interceptor';
import { PhotosService } from 'src/photos/photos.service';
import { S3BucketService } from 'src/s3-bucket/s3-bucket.service';
import { Harness, clientId } from './harness';

const SECRET = 'groups-http-test-secret';

/**
 * POST /api/groups/create-group through the production HTTP pipeline: JWT
 * strategy, global validation pipe, response interceptors and exception
 * filter, exactly as the mobile app calls it.
 */
describe('Groups HTTP (create-group)', () => {
  const h = new Harness();
  const jwt = new JwtService({ secret: SECRET });
  let app: INestApplication;

  const mobileToken = (sub: string) => jwt.sign({ sub, auth_method: 'otp' });
  const post = (token?: string) => {
    const call = request(app.getHttpServer())
      .post('/api/groups/create-group')
      .set('X-Client-Platform', 'mobile');
    return token ? call.set('Authorization', `Bearer ${token}`) : call;
  };

  beforeAll(async () => {
    await h.start();
    const module = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [GroupController],
      providers: [
        JwtStrategy,
        { provide: GroupService, useValue: h.groups },
        { provide: getConnectionToken(), useValue: h.connection },
        {
          provide: ConfigService,
          useValue: { get: (key: string) => (key === 'JWT_SECRET' ? SECRET : undefined) },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(applicationValidationPipe());
    app.useGlobalInterceptors(
      new ResponseInterceptor(),
      new PhotoResponseInterceptor(
        new PhotosService(h.connection, { keyFromReference: () => '' } as unknown as S3BucketService),
      ),
    );
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
    await h.stop();
  });
  beforeEach(() => h.reset());

  it('lets a regular (non-admin) user create a group from the payload the app sends', async () => {
    const [owner, a, b] = await h.users(3);
    const res = await post(mobileToken(owner))
      .send({ name: ' Book club ', description: 'Monthly', members: [a, b], clientId: clientId() })
      .expect(201);
    expect(res.body).toMatchObject({ statusCode: 201, error: false });
    expect(res.body.data).toMatchObject({ name: 'Book club', description: 'Monthly' });
    expect(res.body.data.members.map(String).sort()).toEqual([owner, a, b].sort());
    expect(res.body.data).not.toHaveProperty('clientId');
    expect(await h.models.Group.countDocuments()).toBe(1);
  });

  it('returns 400 with field-level errors for invalid input', async () => {
    const [owner] = await h.users(1);
    const res = await post(mobileToken(owner)).send({ name: '', members: ['not-an-id'] }).expect(400);
    expect(res.body.statusCode).toBe(400);
    expect(res.body.errors).toEqual(
      expect.objectContaining({ name: expect.any(Array), members: expect.any(Array) }),
    );
    // Existing clients still read the flat list.
    expect(res.body.message).toEqual(
      expect.arrayContaining([expect.stringMatching(/name/), expect.stringMatching(/members/)]),
    );
    expect(await h.models.Group.countDocuments()).toBe(0);
  });

  it('returns 400 when a selected member does not exist', async () => {
    const [owner] = await h.users(1);
    const res = await post(mobileToken(owner))
      .send({ name: 'Ghosts', members: ['507f1f77bcf86cd799439011'] })
      .expect(400);
    expect(res.body.message).toMatch(/unavailable/i);
  });

  it('returns 401 without a token, with a password token on mobile, and with a bad signature', async () => {
    const [owner, a] = await h.users(2);
    const body = { name: 'Nope', members: [a] };
    await post().send(body).expect(401);
    await post(jwt.sign({ sub: owner })).send(body).expect(401);
    await post(new JwtService({ secret: 'other' }).sign({ sub: owner, auth_method: 'otp' }))
      .send(body)
      .expect(401);
    expect(await h.models.Group.countDocuments()).toBe(0);
  });

  it('returns the first group for a retried clientId and 409 when it is reused for another group', async () => {
    const [owner, a] = await h.users(2);
    const body = { name: 'Once', members: [a], clientId: clientId() };
    const first = await post(mobileToken(owner)).send(body).expect(201);
    const retry = await post(mobileToken(owner)).send(body).expect(201);
    expect(String(retry.body.data._id)).toBe(String(first.body.data._id));
    const conflict = await post(mobileToken(owner)).send({ ...body, name: 'Other' }).expect(409);
    expect(conflict.body.message).toMatch(/already used/);
    expect(await h.models.Group.countDocuments()).toBe(1);
  });
});
