import { HealthController } from './health.controller';
import { validateBackendEnvironment } from '../security-environment';
import { assertDeploymentIndexes } from './indexes';

const environment = () => ({ NODE_ENV: 'production', PORT: '9000',
  DATABASE_URL: 'mongodb://db:27017/?replicaSet=rs0', DATABASE_NAME: 'test',
  JWT_SECRET: 'zQ4kL7mN2pR9vX5sB8cD3fG6hJ1aW0uY',
  PASSWORD_ENCRYPTION_PRIVATE_KEY: 'ac8f3d9e1b027654'.repeat(4),
  PUBLIC_API_URL: 'https://api.example.test', PUBLIC_SITE_DOMAIN: 'https://app.example.test',
  AWS_DEFAULT_S3_BUCKET: 'private-bucket', AWS_REGION: 'ap-south-1',
  AWS_SES_REGION: 'ap-south-1', AWS_MAIL_FROM: 'sender@example.test',
  TWILIO_ACCOUNT_SID: 'AC-test', TWILIO_AUTH_TOKEN: 'test-token', TWILIO_VERIFY_SERVICE_SID: 'VA-test',
});
describe('Deployment safeguards', () => {
  it('accepts role-based production settings without static AWS keys', () => {
    expect(() => validateBackendEnvironment(environment())).not.toThrow();
  });
  it('accepts the Atlas SRV host but rejects an unreplaced password placeholder', () => {
    const url = 'mongodb+srv://aditya:synthetic-test-password@cluster0.by1ww6f.mongodb.net/darkfantasy?retryWrites=true&w=majority';
    expect(() => validateBackendEnvironment({ ...environment(), DATABASE_URL: url })).not.toThrow();
    expect(() => validateBackendEnvironment({ ...environment(), DATABASE_URL: url.replace('synthetic-test-password', '<db_password>') })).toThrow('placeholder');
  });
  it.each(['DATABASE_URL', 'AWS_SES_REGION', 'TWILIO_AUTH_TOKEN', 'JWT_SECRET'])('rejects missing %s', key => {
    expect(() => validateBackendEnvironment({ ...environment(), [key]: '' })).toThrow();
  });
  it.each([{ PUBLIC_API_URL: 'http://example.test' }, { PUBLIC_SITE_DOMAIN: 'https://user:pass@example.test' },
    { OTP_DEV_FAKE_CODE: '123456' }, { PHOTO_VERIFY_BUCKET_SETTINGS: 'false' }, { PORT: 'not-a-port' }, { EXPIRES_IN: 'invalid' }])('rejects unsafe deployment settings %p', changes => {
    expect(() => validateBackendEnvironment({ ...environment(), ...changes })).toThrow();
  });
  it('readiness fails when MongoDB is disconnected and recovers on a successful ping', async () => {
    const db: any = { readyState: 0, db: { admin: () => ({ command: jest.fn().mockResolvedValue({ ok: 1 }) }) } };
    const health = new HealthController(db);
    expect(health.live()).toEqual({ status: 'ok' });
    await expect(health.ready()).rejects.toThrow('Database is unavailable');
    db.readyState = 1;
    await expect(health.ready()).resolves.toEqual({ status: 'ready' });
  });
  it('rejects missing unique indexes without mutating the database', async () => {
    const db: any = { db: { collection: () => ({ listIndexes: () => ({ toArray: async () => [] }) }) } };
    await expect(assertDeploymentIndexes(db)).rejects.toThrow('migrate:deploy');
  });
});
