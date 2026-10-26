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
import { validateBackendEnvironment } from './security-environment';
import { SubscriptionsModule } from './subscription/subscription.module';
import { StripeModule } from './stripe/stripe.module';
import { GroupModule } from './group-chat/group.module';
import { CouponModule } from './coupon/coupon.module';
import { UserSubscriptionsModule } from './user-subscription/user-subscription.module';
import { NotificationModule } from './notification/notification.module';
import { ContactModule } from './contact/contact.module';
import { memoryStorage } from 'multer';
import { PhotosModule } from './photos/photos.module';
import { VaultModule } from './vault/vault.module';
import { UserBlocksModule } from './user-blocks/user-blocks.module';
import { blockContext, blockQueryPlugin } from './user-blocks/block-context';
import { ReportsModule } from './reports/reports.module';
import { GodChatModule } from './god-chat/god-chat.module';
import { EntitlementsModule } from './entitlements/entitlements.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      envFilePath: [`.env.${process.env.NODE_ENV || 'development'}`, '.env'],
      isGlobal: true,
      cache: true,
      validate: validateBackendEnvironment,
    }),
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        uri: configService.get<string>('DATABASE_URL'),
        dbName: configService.get<string>('DATABASE_NAME'),
        autoIndex: false,
        connectionFactory: (connection) => {
          connection.plugin(blockQueryPlugin);
          return connection;
        },
      }),
      inject: [ConfigService],
    }),
    MulterModule.register({
      storage: memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024, files: 5, fields: 30, parts: 35 },
    }),
    PhotosModule,
    EntitlementsModule,
    VaultModule,
    UserBlocksModule,
    ReportsModule,
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
    GodChatModule,
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
  ],
})
export class AppModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply((req, _res, next) =>
        blockContext.run(
          { bypass: /^\/(?:api\/)?mod(?:\/|$)/.test(req.path), authSelf: /^\/(?:api\/)?auth\/me\/?$/.test(req.path) },
          next,
        ),
      )
      .forRoutes('*');
    consumer.apply(ApiLoggerMiddleware).forRoutes('*');
  }
}
