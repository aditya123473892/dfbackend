import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Group, GroupSchema } from '../common/schemas/group-chat.schema';
import { GroupService } from './group.service';
import { GroupController } from './group.controller';
import { S3BucketService } from 'src/s3-bucket/s3-bucket.service';

@Module({
  imports: [MongooseModule.forFeature([{ name: Group.name, schema: GroupSchema }])],
  controllers: [GroupController],
  providers: [GroupService, S3BucketService],
  exports: [GroupService],
})

export class GroupModule {}
