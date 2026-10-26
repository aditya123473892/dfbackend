import { Module } from '@nestjs/common';
import { VaultService } from './vault.service';
import { VaultController } from './vault.controller';
import { S3BucketService } from '../s3-bucket/s3-bucket.service';
@Module({ controllers: [VaultController], providers: [VaultService, S3BucketService] })
export class VaultModule {}
