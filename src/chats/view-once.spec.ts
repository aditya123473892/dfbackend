import {
  BadRequestException,
  ForbiddenException,
  GoneException,
} from '@nestjs/common';
import { validate } from 'class-validator';
import { ChatService } from './chats.service';
import { CreateChatMessageDto } from './dto/create-chat-message.dto';
import { unblockedPolicy } from '../user-blocks/block.fixture';

const sender = '507f1f77bcf86cd799439011';
const receiver = '507f1f77bcf86cd799439012';
const messageId = '507f1f77bcf86cd799439015';
const mediaId = '507f1f77bcf86cd799439016';

function harness(viewOnce = true) {
  const document: any = {
    _id: messageId,
    sender,
    receiver,
    viewOnce,
    media: [
      { _id: mediaId, storageKey: 'private/photo.jpg', mimetype: 'image/jpeg' },
    ],
  };
  const model: any = jest.fn((data) => ({
    save: jest.fn().mockResolvedValue(data),
  }));
  model.findById = jest.fn(() => ({
    select: jest.fn().mockResolvedValue(document),
  }));
  model.findOne = jest.fn().mockResolvedValue(null);
  model.findOneAndUpdate = jest.fn(async () => {
    if (document.viewedAt) return null;
    document.viewedAt = new Date();
    return document;
  });
  const photos: any = {
    readChatPhoto: jest.fn().mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff])),
    accessUrl: jest.fn().mockResolvedValue('https://example.com/photo.jpg'),
    reserveChatMessage: jest.fn().mockResolvedValue(messageId),
    bind: jest.fn().mockResolvedValue(document.media),
  };
  const service = new ChatService(
    model,
    { exists: jest.fn().mockResolvedValue({}) } as any,
    {} as any,
    { create: jest.fn() } as any,
    {} as any,
    photos,
    unblockedPolicy(),
  );
  return { service, model, photos, document };
}

describe('View-once photo sharing', () => {
  it('never issues a reusable URL for restricted photos, including legacy clients', async () => {
    const { service, photos } = harness();
    await expect(
      service.getMediaAccessUrl(receiver, messageId, mediaId),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(photos.accessUrl).not.toHaveBeenCalled();
  });

  it.each([3, 10, 30, 60])(
    'persists a %ss timed photo as a single-opening message',
    async (seconds) => {
      const { service } = harness();
      const result = await service.createMediaMessage(sender, {
        receiver,
        photoIds: ['photo-id'],
        clientId: 'photo-client-123',
        viewDurationSeconds: seconds,
      });
      expect(result).toMatchObject({
        viewOnce: true,
        viewDurationSeconds: seconds,
      });
    },
  );

  it('returns only in-memory photo bytes and consumes a timed photo once', async () => {
    const { service, document, model, photos } = harness();
    document.viewDurationSeconds = 10;
    const now = Date.now();
    const result = await service.openRestrictedPhoto(
      receiver,
      messageId,
      mediaId,
    );
    expect(result.dataUri).toBe('data:image/jpeg;base64,/9j/');
    expect(result).not.toHaveProperty('url');
    const update = model.findOneAndUpdate.mock.calls[0][1].$set;
    expect(update['media.$[].expiresAt'].getTime()).toBeGreaterThanOrEqual(
      now + 10_000,
    );
    await expect(
      service.openRestrictedPhoto(receiver, messageId, mediaId),
    ).rejects.toBeInstanceOf(GoneException);
    expect(photos.accessUrl).not.toHaveBeenCalled();
  });

  it('checks revocation and expiration again in the atomic opening claim', async () => {
    const { service, model } = harness();
    model.findOneAndUpdate.mockResolvedValueOnce(null);
    await expect(
      service.openRestrictedPhoto(receiver, messageId, mediaId),
    ).rejects.toBeInstanceOf(GoneException);
    expect(
      model.findOneAndUpdate.mock.calls[0][0].media.$elemMatch,
    ).toMatchObject({
      _id: mediaId,
      status: { $nin: ['revoked', 'quarantined'] },
    });
  });

  it('rejects invalid viewing timers', async () => {
    const { service } = harness();
    await expect(
      service.createMediaMessage(sender, {
        receiver,
        photoIds: ['a'],
        viewDurationSeconds: 2,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    const dto = Object.assign(new CreateChatMessageDto(), {
      viewDurationSeconds: '10',
    });
    expect(
      (await validate(dto)).some(
        (error) => error.property === 'viewDurationSeconds',
      ),
    ).toBe(true);
  });

  it('stores a message timer and rejects expired-message access', async () => {
    const { service, document } = harness(false);
    const sent = await service.createMediaMessage(sender, {
      receiver,
      message: 'Hello',
      ttlSeconds: 30,
    });
    expect(sent.expiresAt).toBeInstanceOf(Date);
    document.expiresAt = new Date(Date.now() - 1);
    await expect(
      service.getMediaAccessUrl(receiver, messageId, mediaId),
    ).rejects.toBeInstanceOf(GoneException);
  });
  it('accepts only boolean viewOnce values', async () => {
    const dto = new CreateChatMessageDto();
    Object.assign(dto, { viewOnce: 'false' });
    expect(
      (await validate(dto)).some((error) => error.property === 'viewOnce'),
    ).toBe(true);
    dto.viewOnce = true;
    expect(await validate(dto)).toHaveLength(0);
  });

  it('persists the selected viewing mode', async () => {
    const { service } = harness();
    const result = await service.createMediaMessage(sender, {
      receiver,
      photoIds: ['photo-id'],
      clientId: 'photo-client-123',
      viewOnce: true,
    });
    expect(result.viewOnce).toBe(true);
  });

  it.each([
    { receiver, photoIds: [] },
    { receiver, photoIds: ['a', 'b'] },
    { groupId: receiver, photoIds: ['a'] },
  ])('rejects unsupported view-once payloads: %j', async (target) => {
    const { service, photos } = harness();
    await expect(
      service.createMediaMessage(sender, { ...target, viewOnce: true }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(photos.bind).not.toHaveBeenCalled();
  });

  it('lets the recipient open once and rejects a second opening', async () => {
    const { service, model, photos } = harness();
    await expect(
      service.openRestrictedPhoto(receiver, messageId, mediaId),
    ).resolves.toHaveProperty('dataUri');
    await expect(
      service.openRestrictedPhoto(receiver, messageId, mediaId),
    ).rejects.toBeInstanceOf(GoneException);
    expect(photos.readChatPhoto).toHaveBeenCalledTimes(1);
    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: messageId, receiver, viewedAt: null }),
      {
        $set: {
          viewedAt: expect.any(Date),
          'media.$[].expiresAt': expect.any(Date),
        },
      },
      { new: true },
    );
  });

  it('allows only one concurrent opening across devices', async () => {
    const { service, photos } = harness();
    const results = await Promise.allSettled([
      service.openRestrictedPhoto(receiver, messageId, mediaId),
      service.openRestrictedPhoto(receiver, messageId, mediaId),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(photos.readChatPhoto).toHaveBeenCalledTimes(2);
  });

  it('does not consume the opening when storage fails to read the photo', async () => {
    const { service, model, photos } = harness();
    photos.readChatPhoto.mockRejectedValueOnce(
      new Error('Storage unavailable'),
    );
    await expect(
      service.openRestrictedPhoto(receiver, messageId, mediaId),
    ).rejects.toThrow('Storage unavailable');
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
    await expect(
      service.openRestrictedPhoto(receiver, messageId, mediaId),
    ).resolves.toHaveProperty('dataUri');
  });

  it('prevents the sender from consuming the recipient opening', async () => {
    const { service, model, photos } = harness();
    await expect(
      service.openRestrictedPhoto(sender, messageId, mediaId),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
    expect(photos.readChatPhoto).not.toHaveBeenCalled();
  });

  it('keeps unlimited photos accessible on repeated opens', async () => {
    const { service, model, photos } = harness(false);
    await service.getMediaAccessUrl(receiver, messageId, mediaId);
    await service.getMediaAccessUrl(receiver, messageId, mediaId);
    expect(photos.accessUrl).toHaveBeenCalledTimes(2);
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('includes the opened status in refreshed history', async () => {
    const { service, model } = harness();
    await service.openRestrictedPhoto(receiver, messageId, mediaId);
    model.find = jest.fn(() => ({
      sort: jest.fn().mockResolvedValue([
        {
          _id: messageId,
          sender,
          receiver,
          viewOnce: true,
          viewedAt: new Date(),
        },
      ]),
    }));
    const history = await service.getChatHistory(receiver, sender);
    expect(history[0]).toMatchObject({
      viewOnce: true,
      viewedAt: expect.any(Date),
    });
  });
});
