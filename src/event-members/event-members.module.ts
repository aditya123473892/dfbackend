import { Module } from '@nestjs/common';
import { EventMembersService } from './event-members.service';
import { EventMembersController } from './event-members.controller';
import { MongooseModule } from '@nestjs/mongoose';
import {
  EventMembers,
  EventMembersSchema,
} from 'src/common/schemas/event-members.schema';
import { EventsModule } from 'src/events/events.module';
import { NotificationModule } from '../notification/notification.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      {
        name: EventMembers.name,
        schema: EventMembersSchema,
      },
    ]),
    EventsModule,
    NotificationModule,
  ],
  controllers: [EventMembersController],
  providers: [EventMembersService],
})
export class EventMembersModule {}
