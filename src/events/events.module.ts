import { Module } from '@nestjs/common';
import { EventsService } from './events.service';
import { EventsController } from './events.controller';
import { MongooseModule } from '@nestjs/mongoose';
import { Events, EventsSchema } from 'src/common/schemas/events.schema';
import { EventMembers, EventMembersSchema } from 'src/common/schemas/event-members.schema';
import { S3BucketService } from 'src/s3-bucket/s3-bucket.service';
import { MailService } from 'src/mail/mail.service';
import { UsersModule } from '../users/users.module';
import { FileHandlebarsAdapter } from 'src/common/adapters';

@Module({
  imports: [
    UsersModule,
    MongooseModule.forFeature([
      {
        name: Events.name,
        schema: EventsSchema,
      },
    ]),
    MongooseModule.forFeature([
      {
        name: EventMembers.name,
        schema: EventMembersSchema,
      },
    ]),
  ],
  controllers: [EventsController],
  providers: [
    EventsService,
    S3BucketService,
    MailService,
    FileHandlebarsAdapter,
  ],
  exports: [EventsService, MongooseModule],
})
export class EventsModule {}
