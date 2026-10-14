import { ForbiddenException, NotFoundException, PayloadTooLargeException, UnsupportedMediaTypeException } from '@nestjs/common';
import { ChatService, hasValidMediaSignature } from './chats.service';
import { ChatMediaStatus } from 'src/common/schemas/media.schema';

const senderId = '507f1f77bcf86cd799439011';
const recipientId = '507f1f77bcf86cd799439012';
const thirdId = '507f1f77bcf86cd799439013';
const groupId = '507f1f77bcf86cd799439014';
const messageId = '507f1f77bcf86cd799439015';
const mediaId = '507f1f77bcf86cd799439016';

function makeDocument(overrides: any = {}) {
  const document: any = {
    _id: messageId,
    sender: senderId,
    receiver: recipientId,
    message: '',
    media: [{
      _id: mediaId,
      storageKey: 'chat-media/server-record-key.jpg',
      mimetype: 'image/jpeg',
      originalname: 'photo.jpg',
      size: 12,
      status: ChatMediaStatus.ACTIVE,
    }],
    save: jest.fn(),
    ...overrides,
  };
  document.save.mockImplementation(async () => document);
  document.toObject = () => ({ ...document, save: undefined, toObject: undefined });
  return document;
}

function makeService(document = makeDocument()) {
  const chatModel: any = jest.fn().mockImplementation((data) => {
    const saved = makeDocument({ ...data });
    saved.media = (data.media || []).map((media: any) => ({ ...media, _id: mediaId }));
    return saved;
  });
  chatModel.findById = jest.fn(() => ({ select: jest.fn().mockResolvedValue(document) }));
  chatModel.find = jest.fn(() => ({
    sort: jest.fn().mockResolvedValue([document]),
    populate: jest.fn(() => ({ sort: jest.fn().mockResolvedValue([document]) })),
  }));
  chatModel.updateMany = jest.fn().mockResolvedValue({});
  chatModel.deleteOne = jest.fn().mockResolvedValue({});
  chatModel.countDocuments = jest.fn().mockResolvedValue(0);
  const users: any = {
    exists: jest.fn().mockResolvedValue({ _id: recipientId }),
    findById: jest.fn().mockResolvedValue({ _id: senderId, roles: [] }),
    findByIdAndUpdate: jest.fn().mockResolvedValue({}),
  };
  const groups: any = { exists: jest.fn().mockResolvedValue({ _id: groupId }) };
  const audit: any = { create: jest.fn().mockResolvedValue({}) };
  const s3: any = {
    uploadPrivateFile: jest.fn().mockResolvedValue({ Key: 'uploaded' }),
    getSignedURL: jest.fn().mockResolvedValue('https://signed.example/object'),
    deleteOne: jest.fn().mockResolvedValue({}),
  };
  return {
    service: new ChatService(chatModel, users, groups, audit, s3),
    chatModel, users, groups, audit, s3,
  };
}

describe('ChatService media authorization', () => {
  afterEach(() => jest.restoreAllMocks());

  it('allows a direct-chat sender and recipient to access media', async () => {
    const { service } = makeService();
    await expect(service.getMediaAccessUrl(senderId, messageId, mediaId)).resolves.toMatchObject({ expiresIn: 120 });
    await expect(service.getMediaAccessUrl(recipientId, messageId, mediaId)).resolves.toMatchObject({ url: expect.any(String) });
  });

  it('conceals direct media from a third user', async () => {
    const { service, audit } = makeService();
    await expect(service.getMediaAccessUrl(thirdId, messageId, mediaId)).rejects.toBeInstanceOf(NotFoundException);
    expect(audit.create).toHaveBeenCalledWith(expect.objectContaining({ action: 'media_access_denied' }));
  });

  it('uses only the object key from the authorized message record', async () => {
    const { service, s3 } = makeService();
    await service.getMediaAccessUrl(senderId, messageId, mediaId);
    expect(s3.getSignedURL).toHaveBeenCalledWith('chat-media/server-record-key.jpg', undefined, 120);
  });

  it('allows a current group member to access group media', async () => {
    const { service, groups } = makeService(makeDocument({ groupId, receiver: undefined }));
    await expect(service.getMediaAccessUrl(senderId, messageId, mediaId)).resolves.toBeDefined();
    expect(groups.exists).toHaveBeenCalledWith(expect.objectContaining({ _id: groupId }));
  });

  it('denies a non-member or removed member new group access URLs', async () => {
    const { service, groups } = makeService(makeDocument({ groupId, receiver: undefined }));
    groups.exists.mockResolvedValue(null);
    await expect(service.getMediaAccessUrl(thirdId, messageId, mediaId)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('allows only the sender to revoke media', async () => {
    const { service } = makeService();
    await expect(service.revokeMedia(recipientId, messageId, mediaId)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.revokeMedia(senderId, messageId, mediaId)).resolves.toBeDefined();
  });

  it('does not issue URLs for revoked media', async () => {
    const document = makeDocument();
    document.media[0].status = ChatMediaStatus.REVOKED;
    const { service, s3 } = makeService(document);
    await expect(service.getMediaAccessUrl(senderId, messageId, mediaId)).rejects.toBeInstanceOf(NotFoundException);
    expect(s3.getSignedURL).not.toHaveBeenCalled();
  });

  it('does not issue URLs for expired media', async () => {
    const document = makeDocument();
    document.media[0].expiresAt = new Date(Date.now() - 1000);
    const { service, s3, audit } = makeService(document);
    await expect(service.getMediaAccessUrl(senderId, messageId, mediaId)).rejects.toBeInstanceOf(NotFoundException);
    expect(s3.getSignedURL).not.toHaveBeenCalled();
    expect(audit.create).toHaveBeenCalledWith(expect.objectContaining({ action: 'media_expired' }));
  });

  it('rejects unsupported and signature-mismatched files', async () => {
    const { service } = makeService();
    const file = { originalname: 'payload.svg', mimetype: 'image/svg+xml', size: 20, buffer: Buffer.from('<svg><script>') } as Express.Multer.File;
    await expect(service.createMediaMessage(senderId, { receiver: recipientId }, [file])).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
    const fakeJpeg = { ...file, originalname: 'fake.jpg', mimetype: 'image/jpeg', buffer: Buffer.alloc(20) } as Express.Multer.File;
    await expect(service.createMediaMessage(senderId, { receiver: recipientId }, [fakeJpeg])).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
  });

  it('rejects oversized uploads', async () => {
    const previous = process.env.CHAT_MEDIA_MAX_FILE_SIZE;
    process.env.CHAT_MEDIA_MAX_FILE_SIZE = '10';
    const { service } = makeService();
    const file = { originalname: 'photo.jpg', mimetype: 'image/jpeg', size: 20, buffer: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(17)]) } as Express.Multer.File;
    await expect(service.createMediaMessage(senderId, { receiver: recipientId }, [file])).rejects.toBeInstanceOf(PayloadTooLargeException);
    process.env.CHAT_MEDIA_MAX_FILE_SIZE = previous;
  });

  it('recognizes supported magic bytes', () => {
    expect(hasValidMediaSignature('image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))).toBe(true);
    expect(hasValidMediaSignature('image/png', Buffer.alloc(12))).toBe(false);
  });

  it('scopes direct history to the authenticated actor and selected peer', async () => {
    const { service, chatModel } = makeService();
    await service.getChatHistory(senderId, recipientId);
    expect(chatModel.find).toHaveBeenCalledWith({
      $or: [
        { sender: senderId, receiver: recipientId },
        { sender: recipientId, receiver: senderId },
      ],
    });
  });
});
