import { ValidationPipe } from '@nestjs/common';
import { Types } from 'mongoose';
import { NotificationController } from './notification.controller';
import { NotificationPageDto, ReadNotificationsDto } from './notification.dto';
import { NotificationService } from './notification.service';

describe('Notifications ownership and privacy', () => {
  const owner = '507f1f77bcf86cd799439011', foreign = '507f1f77bcf86cd799439012';
  it('requires authentication and rejects caller-provided identity and invalid cursors', async () => {
    expect(Reflect.getMetadata('__guards__', NotificationController)).toHaveLength(1);
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true });
    await expect(pipe.transform({ receiver: foreign }, { type: 'body', metatype: ReadNotificationsDto })).rejects.toThrow();
    await expect(pipe.transform({ before: 'invalid' }, { type: 'query', metatype: NotificationPageDto })).rejects.toThrow();
  });
  it('scopes selected and all-read updates to the authenticated receiver', async () => {
    const model: any = { updateMany: jest.fn().mockResolvedValue({ modifiedCount: 0 }) };
    const service = new NotificationService(model, {} as any);
    await service.markRead(owner, [foreign]);
    expect(model.updateMany.mock.calls[0][0]).toEqual({ receiver: owner,
      _id: { $in: [foreign] }, isRead: { $ne: true } });
    await service.markRead(owner);
    expect(model.updateMany.mock.calls[1][0]).toEqual({ receiver: owner, isRead: { $ne: true } });
  });
  it('bounds pages, scopes reads, excludes raw moderation metadata, and counts unread separately', async () => {
    const rows = Array.from({ length: 21 }, () => ({ _id: new Types.ObjectId(), type: 'moderation_notice',
      message: 'Notice', createdAt: new Date(), metadata: { reportId: 'private-case', reporterId: foreign } }));
    const query: any = { lean: async () => rows };
    for (const name of ['sort', 'limit', 'select', 'populate']) query[name] = jest.fn().mockReturnValue(query);
    const model: any = { find: jest.fn().mockReturnValue(query), countDocuments: jest.fn().mockResolvedValue(35) };
    const result = await new NotificationService(model, {} as any).list(owner, foreign);
    expect(model.find.mock.calls[0][0].receiver).toBe(owner);
    expect(query.limit).toHaveBeenCalledWith(21);
    expect(result.notifications).toHaveLength(20);
    expect(result.unreadCount).toBe(35);
    expect(result.nextCursor).toBe(String(rows[19]._id));
    expect(result.notifications[0].read).toBe(false);
    expect(JSON.stringify(result)).not.toContain('private-case');
    expect(JSON.stringify(result)).not.toContain(foreign);
  });
});
