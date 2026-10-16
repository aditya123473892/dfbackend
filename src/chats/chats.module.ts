import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ChatGateway } from './chats.gateway';
import { ChatService } from './chats.service';
import { ChatMessage, ChatMessageSchema } from '../common/schemas/chats.schema';
import { UserSubscriptionsModule } from 'src/user-subscription/user-subscription.module';
import { UserSubscriptionService } from 'src/user-subscription/user-subscription.service';
import { S3BucketService } from 'src/s3-bucket/s3-bucket.service';
import { MailModule } from 'src/mail/mail.module';
import { UsersModule } from 'src/users/users.module';
import { CouponModule } from 'src/coupon/coupon.module';
import { Users, UsersSchema } from 'src/common/schemas';
import { Group, GroupSchema } from 'src/common/schemas/group-chat.schema';
import {
  ChatMediaAudit,
  ChatMediaAuditSchema,
} from 'src/common/schemas/chat-media-audit.schema';
import {
  ChatReadCursor,
  ChatReadCursorSchema,
} from 'src/common/schemas/chat-read-cursor.schema';
import { ChatsController } from './chats.controller';
import { ChatExpiryService } from './chat-expiry.service';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ChatMessage.name, schema: ChatMessageSchema },
      { name: Users.name, schema: UsersSchema },
      { name: Group.name, schema: GroupSchema },
      { name: ChatMediaAudit.name, schema: ChatMediaAuditSchema },
      { name: ChatReadCursor.name, schema: ChatReadCursorSchema },
    ]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: configService.get<string>('EXPIRES_IN') },
      }),
      inject: [ConfigService],
    }),
    UserSubscriptionsModule,
    MailModule,
    UsersModule,
    CouponModule,
  ],
  controllers: [ChatsController],
  providers: [ChatGateway, ChatService, S3BucketService, ChatExpiryService],
  exports: [MongooseModule, ChatService, ChatGateway],
})
export class ChatModule {}
