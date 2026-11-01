import { S3BucketService } from '../s3-bucket/s3-bucket.service';
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
});
