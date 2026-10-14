import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { PassportModule } from '@nestjs/passport';
import { AuthService } from 'src/auth/auth.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

//Schemas
import { UsersSchema, Users, Posts, PostsSchema } from '../common/schemas';
import { S3BucketService } from 'src/s3-bucket/s3-bucket.service';
import {
  UserEditHistory,
  UserEditHistorySchema,
} from 'src/common/schemas/user-profile-edit.schema';
import { Follow, FollowSchema } from 'src/common/schemas/follow.schema';
import { MailModule } from 'src/mail/mail.module';
import { PostRequest, PostRequestSchema } from 'src/common/schemas/posts-request.schema';
import { UserBookMark, UserBookMarkSchema } from 'src/common/schemas/user-bookmark.schema';
import { ChatMessage, ChatMessageSchema } from 'src/common/schemas/chats.schema';

@Module({
  imports: [
    PassportModule,
    MailModule,
    PostRequest,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        signOptions: {
          expiresIn: configService.get<string>('EXPIRES_IN'),
        },
        secret: configService.get<string>('JWT_SECRET'),
      }),
      inject: [ConfigService],
    }),
    MongooseModule.forFeature([
      {
        name: Users.name,
        schema: UsersSchema,
      },
      {
        name: UserEditHistory.name,
        schema: UserEditHistorySchema,
      },
      {
        name: Follow.name,
        schema: FollowSchema,
      },
      {
        name: Posts.name,
        schema: PostsSchema,
      },
      {
        name: PostRequest.name,
        schema: PostRequestSchema,
      },
      {
        name: UserBookMark.name,
        schema: UserBookMarkSchema,
      },
      {
        name: ChatMessage.name,
        schema: ChatMessageSchema,
      },
    ]),
  ],
  controllers: [UsersController],
  providers: [UsersService, AuthService, S3BucketService],
  exports: [UsersService],
})
export class UsersModule {}
