import { Injectable, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, createConnection } from 'mongoose';
import { modEnabled, verifyModConfiguration } from './mod.guard';
@Injectable()
export class StaffAuditService implements OnModuleInit, OnModuleDestroy {
  private auditDb: Connection;
  constructor(@InjectConnection() private readonly db: Connection) {}
  async onModuleInit() {
    verifyModConfiguration();
    if (modEnabled() && process.env.STAFF_AUDIT_DATABASE_URL)
      this.auditDb = await createConnection(process.env.STAFF_AUDIT_DATABASE_URL, {
        dbName: process.env.DATABASE_NAME, serverSelectionTimeoutMS: 5000,
      }).asPromise();
  }
  async onModuleDestroy() { await this.auditDb?.close(); }
  // Deliberately no update/delete/find methods. Operator creates indexes separately.
  async append(row: { actorId: string; role: string; action: string; reportId: string; targetUserId?: string; contentId?: string; s3Key?: string; reason: string }) {
    try {
      await (this.auditDb || this.db).db.collection('StaffAuditLog').insertOne({
        ...row, timestamp: new Date(),
      }, { writeConcern: { w: 'majority' } });
    } catch { throw new ServiceUnavailableException('Staff audit is unavailable'); }
  }
}
