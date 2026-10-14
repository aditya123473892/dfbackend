import { MiddlewareConsumer, Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { APP_FILTER } from '@nestjs/core';
import { GlobalExceptionFilter } from './common/interceptors';
import { MailModule } from './mail/mail.module';
import { MulterModule } from '@nestjs/platform-express';
import { ApiLoggerMiddleware } from './common/middlewares';
import { PostsModule } from './posts/posts.module';
import { ChatModule } from './chats/chats.module';
import { EventsModule } from './events/events.module';
import { S3BucketService } from './s3-bucket/s3-bucket.service';
import { EventMembersModule } from './event-members/event-members.module';
import { ScheduleModule } from '@nestjs/schedule';
import { ImageURLService } from './jobs/image-url.service';
import { SubscriptionsModule } from './subscription/subscription.module';
import { StripeModule } from './stripe/stripe.module';
import { GroupModule } from './group-chat/group.module';
import { CouponModule } from './coupon/coupon.module';
import { UserSubscriptionsModule } from './user-subscription/user-subscription.module';
import { NotificationModule } from './notification/notification.module';
import { ContactModule } from './contact/contact.module';
import { memoryStorage } from 'multer';

@Module({
  imports: [
    ConfigModule.forRoot({
      envFilePath: ['.env.production', '.env.development'],
      isGlobal: true,
      cache: true,
    }),
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        uri: configService.get<string>('DATABASE_URL'),
        dbName: configService.get<string>('DATABASE_NAME'),
      }),
      inject: [ConfigService],
    }),
    MulterModule.register({
      storage: memoryStorage(),
    }),
    AuthModule,
    UsersModule,
    MailModule,
    PostsModule,
    ChatModule,
    EventsModule,
    EventMembersModule,
    SubscriptionsModule,
    StripeModule,
    GroupModule,
    UserSubscriptionsModule,
    CouponModule,
    NotificationModule,
    ContactModule,
    ScheduleModule.forRoot(),
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
    S3BucketService,
    ImageURLService,
  ],
})
export class AppModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(ApiLoggerMiddleware).forRoutes('v1/*');
  }
}
