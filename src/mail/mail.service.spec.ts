import { SES } from '@aws-sdk/client-ses';
import { MailService } from './mail.service';

describe('MailService AWS v3', () => {
  it('uses the credential provider chain for role deployments and never mocks missing production delivery', async () => {
    const keys = ['AWS_ACCESS_KEY', 'AWS_SECRET', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
      'AWS_SES_REGION', 'AWS_MAIL_FROM', 'NODE_ENV'];
    const previous = keys.map(key => process.env[key]);
    const send = jest.spyOn(SES.prototype, 'sendEmail').mockResolvedValue({ MessageId: 'role-send' } as never);
    try {
      for (const key of keys) delete process.env[key];
      Object.assign(process.env, { NODE_ENV: 'production', AWS_SES_REGION: 'ap-south-1', AWS_MAIL_FROM: 'sender@example.test' });
      const service = new MailService({ compile: async () => 'reset' } as any);
      await expect(service.resetPassword('recipient@example.test', 'Member', 'https://example.test/reset'))
        .resolves.toMatchObject({ MessageId: 'role-send' });
      expect(send).toHaveBeenCalledTimes(1);
      delete process.env.AWS_SES_REGION;
      await expect(service.resetPassword('recipient@example.test', 'Member', 'https://example.test/reset'))
        .rejects.toThrow('Password reset email delivery failed');
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      send.mockRestore();
      keys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
      });
    }
  });
  it('awaits the SES promise and preserves the reset email content', async () => {
    const keys = ['AWS_ACCESS_KEY', 'AWS_SECRET', 'AWS_SES_REGION', 'AWS_MAIL_FROM'];
    const previous = keys.map(key => process.env[key]);
    Object.assign(process.env, {
      AWS_ACCESS_KEY: 'test-key', AWS_SECRET: 'test-secret',
      AWS_SES_REGION: 'ap-south-1', AWS_MAIL_FROM: 'sender@example.com',
    });
    const send = jest.spyOn(SES.prototype, 'sendEmail').mockResolvedValue({ MessageId: 'test-message', $metadata: {} } as never);
    const compile = jest.fn().mockResolvedValue('<p>Reset link</p>');
    try {
      const service = new MailService({ compile } as any);
      await expect(service.resetPassword('recipient@example.com', 'Name', 'https://example.com/reset')).resolves.toMatchObject({ MessageId: 'test-message' });
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        Destination: { ToAddresses: ['recipient@example.com'] },
        Message: expect.objectContaining({ Body: { Html: { Charset: 'UTF-8', Data: '<p>Reset link</p>' } } }),
      }));
    } finally {
      send.mockRestore();
      keys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
      });
    }
  });
});
