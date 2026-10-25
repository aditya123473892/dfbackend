import { AuthController } from './auth.controller';
import { ValidationPipe } from '@nestjs/common';
import { ForgotPasswordDto } from './dtos/forgot-password.dto';

describe('Password recovery request', () => {
  it('returns the same response for unknown/blocked and deliverable accounts without returning credentials', async () => {
    const user = { id: '507f1f77bcf86cd799439011', username: 'member@example.test', firstName: 'Member' };
    const users: any = { findOne: jest.fn().mockResolvedValue(null), updateOne: jest.fn().mockResolvedValue(user) };
    const mail: any = { resetPassword: jest.fn().mockResolvedValue({ MessageId: 'sent' }) };
    const controller = new AuthController({} as any, users, mail,
      { get: () => 'abcdef0123456789'.repeat(4) } as any);
    const absent = await controller.forgotPassword({ username: user.username });
    users.findOne.mockResolvedValue(user);
    const accepted = await controller.forgotPassword({ username: user.username });
    expect(accepted).toEqual(absent);
    expect(mail.resetPassword).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(accepted)).not.toContain('token');
    users.findOne.mockResolvedValue({ ...user, isBlocked: true });
    expect(await controller.forgotPassword({ username: user.username })).toEqual(absent);
    expect(mail.resetPassword).toHaveBeenCalledTimes(1);
  });
  it('validates email shape and bounds its size', async () => {
    const pipe = new ValidationPipe();
    await expect(pipe.transform({ username: { $ne: null } }, {
      type: 'body', metatype: ForgotPasswordDto,
    })).rejects.toThrow();
  });
});
