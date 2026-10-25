import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { S3BucketService } from '../s3-bucket/s3-bucket.service';
import { StaffAuditService } from './staff-audit.service';
import { randomUUID } from 'crypto';
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn().mockResolvedValue('https://private.test/evidence') }));
describe('Moderation private signing and append-only auditing', () => {
  it('signs only ordinary case evidence for sixty seconds with no-store and inline disposition', async () => {
    const before = { ...process.env };
    try {
      Object.assign(process.env, { AWS_DEFAULT_S3_BUCKET: 'private-test', AWS_S3_REGION: 'ap-south-1' });
      const storage = new S3BucketService();
      jest.spyOn(storage, 'ensurePrivate').mockResolvedValue();
      const key = `reports/${randomUUID()}/${randomUUID()}-0.jpg`;
      await storage.signReportEvidence(key);
      expect(getSignedUrl).toHaveBeenLastCalledWith(storage.s3, expect.objectContaining({ input: expect.objectContaining({ Key: key,
        ResponseCacheControl: 'private, no-store', ResponseContentDisposition: 'inline' }) }), { expiresIn: 60 });
      for (const key of ['vault/owner/photo.jpg', 'restricted-reports/case/image.jpg', 'chat/image.jpg'])
        await expect(storage.signReportEvidence(key)).rejects.toThrow('Invalid evidence reference');
    } finally { process.env = before; }
  });
  it('provides only append, commits audit before return and converts insert failures to denial', async () => {
    const insertOne = jest.fn().mockResolvedValue({});
    const audit = new StaffAuditService({ db: { collection: () => ({ insertOne }) } } as any);
    const row = { actorId: 'staff', role: 'admin', reportId: 'case', action: 'evidence_view', reason: 'case_review' };
    await audit.append(row);
    expect(insertOne).toHaveBeenCalledWith({ ...row, timestamp: expect.any(Date) }, { writeConcern: { w: 'majority' } });
    expect((audit as any).update).toBeUndefined(); expect((audit as any).delete).toBeUndefined();
    insertOne.mockRejectedValueOnce(new Error('sensitive database failure'));
    await expect(audit.append(row)).rejects.toMatchObject({ status: 503, message: 'Staff audit is unavailable' });
  });
});
