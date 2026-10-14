import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { Posts, PostsSchema, Users, UsersSchema } from 'src/common/schemas';
import { UsersModule } from 'src/users/users.module';
import { UsersService } from 'src/users/users.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from '../common/guards/jwt.strategy';
import { PassportModule } from '@nestjs/passport';
import { MailModule } from 'src/mail/mail.module';
import { UserEditHistory, UserEditHistorySchema } from 'src/common/schemas/user-profile-edit.schema';
import { Follow, FollowSchema } from 'src/common/schemas/follow.schema';
import { PostRequest, PostRequestSchema } from 'src/common/schemas/posts-request.schema';
import { UserBookMark, UserBookMarkSchema } from 'src/common/schemas/user-bookmark.schema';
import { UserSubscriptionsModule } from 'src/user-subscription/user-subscription.module';
import { ChatModule } from 'src/chats/chats.module';

@Module({
  imports: [
    UsersModule,
    PassportModule,
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
        schema: UsersSchema 
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
    ]),
    MailModule,
    UserSubscriptionsModule,
    ChatModule
  ],
  controllers: [AuthController],
  providers: [AuthService, UsersService, JwtStrategy],
  exports: [AuthService],
})
export class AuthModule {}
