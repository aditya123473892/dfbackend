import { S3BucketService } from '../s3-bucket/s3-bucket.service';
import { VaultService } from './vault.service';
describe('Cloud backup encryption acknowledgment', () => {
  const fixture = (head: any) => {
    const service: any=Object.create(S3BucketService.prototype);
    service.s3={headObject:jest.fn(async()=>head)};
    service.bucketFor=()=> 'private'; return service as S3BucketService;
  };
  it('accepts verified size and server-side encryption only', async () => {
    await expect(fixture({ContentLength:12,ServerSideEncryption:'AES256'}).verifyEncryptedBackup('key',12)).resolves.toBe(true);
    await expect(fixture({ContentLength:12,ServerSideEncryption:'aws:kms'}).verifyEncryptedBackup('key',12)).resolves.toBe(true);
    await expect(fixture({ContentLength:12}).verifyEncryptedBackup('key',12)).rejects.toThrow();
    await expect(fixture({ContentLength:13,ServerSideEncryption:'AES256'}).verifyEncryptedBackup('key',12)).rejects.toThrow();
  });

  it.each([true, false])('only acknowledges a video backup when storage encryption verifies: %s', async verified => {
    const owner = '0123456789abcdef01234567', id = '12345678-1234-4234-8234-123456789abc';
    const row = { _id: `${owner}:${id}`, owner, id, kind: 'video', state: 'scanning', jobId: 'scan',
      tempKey: 'temp/video.mp4', finalKey: `vault/${owner}/${id}.mp4`, contentType: 'video/mp4', size: 100, md5: 'abc' };
    const updateOne = jest.fn(async () => ({ modifiedCount: 1 }));
    const db: any = { db: { collection: (name: string) => ({
      findOne: async () => name === 'VaultPhotos' ? row : null, updateOne,
    }) } };
    const storage: any = { videoModerationResult: jest.fn(async () => 'approved'), copyVideo: jest.fn(),
      verifyEncryptedBackup: jest.fn(async () => { if (!verified) throw new Error('Encryption verification failed'); return true; }),
    };
    const service = new VaultService(db, storage, { assertActiveAccount: jest.fn(), rate: jest.fn(), enqueue: jest.fn() } as any);
    if (verified) {
      await expect(service.confirm(owner, id)).resolves.toMatchObject({ remoteEncrypted: true, status: 'approved' });
      expect(storage.verifyEncryptedBackup).toHaveBeenCalledWith(row.finalKey, 100);
    } else {
      await expect(service.confirm(owner, id)).rejects.toThrow('Encryption verification failed');
      expect(updateOne).not.toHaveBeenCalled();
    }
  });
});
