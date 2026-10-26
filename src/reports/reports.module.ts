import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { S3BucketService } from '../s3-bucket/s3-bucket.service';
import { ModController } from './mod.controller';
import { ModService } from './mod.service';
import { StaffAuditService } from './staff-audit.service';
import { ModCaseGuard, ModFeatureGuard } from './mod.guard';
@Module({
  controllers: [ReportsController, ModController],
  providers: [ReportsService, S3BucketService, ModService, StaffAuditService, ModCaseGuard, ModFeatureGuard],
})
export class ReportsModule {}
