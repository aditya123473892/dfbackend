import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  Patch,
  Query,
  Param,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  NotFoundException,
  Put,
  Delete,
} from '@nestjs/common';
import { PhotosService } from '../photos/photos.service';
import { SelfProfileDto } from './dtos/self-profile.dto';
import { PhotoReferenceDto } from '../photos/photo.dto';
import { ValidationPipe } from '@nestjs/common';
import { toUserResponse, UsersService } from './users.service';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  badRequestRes,
  successRes,
  unAuthorizedRes,
} from 'src/common/interceptors';
import { CreateUserDto, FilterUsersDto, UpdateUserDto } from './dtos';
import { AuthUser, Roles } from 'src/common/decorators';
import { DefaultFindParams, IAuthUser } from 'src/common/interfaces';
import { JwtAuthGuard, RolesGuard } from 'src/common/guards';
import { ERole } from 'src/common/enums';
import { FileInterceptor } from '@nestjs/platform-express';
import { UpdateUserProfileDto } from './dtos/update-user-profile.dto';
import { S3BucketService } from 'src/s3-bucket/s3-bucket.service';
import { CreateUserEditHistoryDto } from './dtos/create-user-edit-history.dto';
import { ApproveUserRequestDto } from './dtos/approve-request.dto';
import { FollowRequestDto } from './dtos/follow-request.dto';
import { FollowStatus } from 'src/common/schemas/follow.schema';
import { MailService } from 'src/mail/mail.service';

@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@ApiTags('Users')
@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly photos: PhotosService,
    private readonly s3BucketService: S3BucketService,
    private readonly mailService: MailService,
  ) {}

  @Get('me')
  async findMe(@AuthUser() authUser: IAuthUser) {
    const user = await this.usersService.findById(authUser.id);
    return user ? successRes({ user: toUserResponse(user, authUser) }) : unAuthorizedRes();
  }

  @UseGuards(RolesGuard)
  @Roles(ERole.ADMIN)
  @Get('history')
  @ApiOperation({ summary: 'Admin fetches all users’ profile change requests' })
  @ApiResponse({
    status: 400,
    description: 'No user edit history found.',
    schema: {
      example: badRequestRes('No user edit history found'),
    },
  })
  async getUserEditHistory() {
    const historyData = await this.usersService.getAllUserEditHistory(false);
    return historyData
      ? successRes(historyData)
      : badRequestRes('No user edit history found');
  }

  @UseGuards(RolesGuard)
  @Roles(ERole.ADMIN)
  @Get('unverified')
  @ApiOperation({ summary: 'Admin fetches all users with unverified emails' })
  @ApiResponse({
    status: 200,
    description: 'List of users with unverified emails.',
  })
  @ApiResponse({
    status: 400,
    description: 'No unverified users found.',
    schema: {
      example: badRequestRes('No unverified users found'),
    },
  })
  async getUnverifiedUsers() {
    const users = await this.usersService.findUnverifiedUsers();
    return users.length
      ? successRes({ users })
      : badRequestRes('No unverified users found');
  }

  @Get('/book-mark')
  @ApiOperation({ summary: 'get Book-Mark User' })
  async getUserBookMark(@AuthUser() authUser: IAuthUser) {
    try {
      const bookMark = await this.usersService.getUserBookMark(authUser.id);
      return successRes({ bookMark }, 'Get Book Marks users successfully');
    } catch (error) {
      return badRequestRes(error.message);
    }
  }

  @Get('/random-online-admin')
  @ApiOperation({ summary: 'get random online admin for chat with god' })
  async getRandomOnlineAdmin() {
    return this.usersService.getRandomOnlineAdmin();
  }

  @Get('/chatlist')
  @ApiOperation({ summary: 'get user chat list' })
  async getUserChatList(@AuthUser() authUser: IAuthUser) {
    const userChatlist = await this.usersService.getUserChatList(authUser.id);
    return successRes({ userChatlist });
  }

  @UseGuards(RolesGuard)
  // @Roles(ERole.ADMIN)
  @Get(':id')
  @ApiParam({ name: 'id', required: true, description: 'User ID to fetch' })
  @ApiResponse({
    status: 200,
    description: 'Successfully fetched user details',
  })
  @ApiResponse({ status: 404, description: 'User not found or blocked' })
  async findOne(@Param('id') userId: string, @AuthUser() actor: IAuthUser) {
    const user = await this.usersService.findByIdWithUserPost(userId, actor.id);
    if (!user) throw new NotFoundException('User not found!');
    return successRes({ user: toUserResponse(user, actor) });
  }

  @UseGuards(RolesGuard)
  // @Roles(ERole.ADMIN)
  @Get()
  async findAll(@Query() params: FilterUsersDto, @AuthUser() authUser: IAuthUser) {
    const options = {
      ...DefaultFindParams,
      ...params,
    };

    const { users, count } = await this.usersService.findAll(options);
    return successRes({ users: users.map((user) => toUserResponse(user, authUser)), count });
  }

  /** Only SelfProfileDto fields; roles, credentials and account state cannot be self-assigned. */
  @Patch('/me')
  async update(
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    updateUserDto: SelfProfileDto,
    @AuthUser() user: IAuthUser,
  ) {
    const updatedUser = await this.usersService.updateOne(
      user.id,
      updateUserDto,
    );

    return updatedUser
      ? successRes({ user: toUserResponse(updatedUser, user) }, 'Profile saved!')
      : badRequestRes('Failed to update!');
  }

  @UseGuards(RolesGuard)
  @Roles(ERole.ADMIN)
  @Post()
  async registerUser(
    @Body() createUserDto: CreateUserDto,
    @AuthUser() authUser: IAuthUser,
  ) {
    const foundUser = await this.usersService.findByUsername(
      createUserDto.username,
    );

    if (foundUser) {
      return badRequestRes(
        'Account already exists with this email!, go to login',
      );
    }

    // Create user
    const user = await this.usersService.create(createUserDto, authUser.id);

    if (!user) badRequestRes('Failed to register new user');

    // Increment login count update last login IP check login IP
    await this.usersService.updateLoginInfo(user._id.toString());

    return successRes({
      user,
      accessToken: '',
      message: 'Logged in successfully',
    });
  }

  @UseGuards(RolesGuard)
  @Roles(ERole.ADMIN)
  @Patch('update/:id')
  async updateOne(
    @Param('id') _id: string,
    @Body() updateUserDto: UpdateUserDto,
    @AuthUser() actor: IAuthUser,
  ) {
    const updatedUser = await this.usersService.updateOne(_id, updateUserDto, actor.id);

    return updatedUser
      ? successRes({ user: updatedUser }, 'User updated!')
      : badRequestRes('Failed to update!');
  }

  @Put('update-profile')
  async updateProfile(
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    dto: SelfProfileDto,
    @AuthUser() actor: IAuthUser,
  ) {
    const user = await this.usersService.updateOneUserProfile(actor.id, dto);
    return successRes({ user });
  }

  @Put('me/avatar')
  async setAvatar(
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    dto: PhotoReferenceDto,
    @AuthUser() actor: IAuthUser,
  ) {
    const ref = `avatar:${actor.id}`;
    const current = await this.usersService.findById(actor.id);
    const [photo] = await this.photos.bind(actor.id, [dto.uploadId], ref);
    const updated = await this.photos.replaceImage(
      'Users',
      actor.id,
      'avatar',
      current?.avatar,
      photo.filename,
    );
    if (current?.avatar && current.avatar !== photo.filename)
      await this.photos.retire(ref, [current.avatar]);
    if (current?.avatar && current.avatar !== photo.filename)
      await this.photos.enqueue([current.avatar]);
    return successRes({ user: updated });
  }

  @Delete('me')
  async deleteAccount(@AuthUser() actor: IAuthUser) {
    await this.photos.requestAccountDeletion(actor.id);
    return successRes({ deletionRequested: true });
  }

  @Post('/book-mark/:userId')
  @ApiOperation({ summary: 'Book-Mark User' })
  async userBookMark(
    @Param('userId') userId: string,
    @AuthUser() authUser: IAuthUser,
  ) {
    try {
      const bookMark = await this.usersService.userBookMark(
        authUser.id,
        userId,
      );
      return successRes({ bookMark }, 'User Book Marks successfully');
    } catch (error) {
      return badRequestRes(error.message);
    }
  }

  @Put('/book-mark/status/:userId')
  @ApiOperation({ summary: 'Update Bookmark Status' })
  async updateBookMarkStatus(
    @Param('userId') userId: string,
    @AuthUser() authUser: IAuthUser,
  ) {
    try {
      const updatedBookMark = await this.usersService.updateBookMarkStatus(
        authUser.id,
        userId,
      );
      return successRes(
        { updatedBookMark },
        'Bookmark status updated successfully',
      );
    } catch (error) {
      return badRequestRes(error.message);
    }
  }

  @Post('send-request')
  @ApiOperation({
    summary: 'User submits a request to update profile with a remark',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        remark: {
          type: 'string',
          description: 'Enter remark',
          example: 'I want to update my email and phone number',
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Request sent successfully.',
    schema: {
      example: successRes({ message: 'Request sent successfully!' }),
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Failed to send request.',
    schema: {
      example: badRequestRes('Failed to send request'),
    },
  })
  async sendRequest(
    @Body() createUserEditHistoryDto: CreateUserEditHistoryDto,
    @AuthUser() user: IAuthUser,
  ) {
    const existingRequest =
      await this.usersService.getUserEditHistoryByUserIdAndStatus(
        user.id,
        false,
      );

    if (existingRequest) {
      return badRequestRes(
        'You already have a pending request. You cannot submit another one.',
      );
    }

    const { remark } = createUserEditHistoryDto;

    const history = await this.usersService.createUserEditHistory(
      user.id,
      remark,
    );

    return history
      ? successRes({ message: 'Request sent successfully!' })
      : badRequestRes('Failed to send request');
  }

  @UseGuards(RolesGuard)
  @Roles(ERole.ADMIN)
  @Put('approve-request/:userId')
  @ApiOperation({ summary: 'Admin approves the user profile change request' })
  @ApiParam({
    name: 'userId',
    description:
      'ID of the user whose profile change request is being approved',
    type: String,
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        status: {
          type: 'boolean',
          description: 'Enter status',
          example: true,
        },
      },
    },
  })
  async approveRequest(
    @Param('userId') userId: string,
    @Body() approveUserRequestDto: ApproveUserRequestDto,
  ) {
    const approvedUser = await this.usersService.approveUserEditRequest(
      userId,
      approveUserRequestDto,
    );

    return approvedUser
      ? successRes({ user: approvedUser }, 'Request approved successfully')
      : badRequestRes('Failed to approve request');
  }

  @Post('/follow/follow-request')
  @ApiOperation({ summary: 'Send a follow request' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        following: {
          type: 'string',
          description: 'User to follow',
          example: '1234567890abcdef',
        },
      },
    },
  })
  async sendFollowRequest(
    @Body() followRequestDto: FollowRequestDto,
    @AuthUser() authUser: IAuthUser,
  ) {
    try {
      const follow = await this.usersService.sendFollowRequest(
        authUser.id,
        followRequestDto.following,
      );
      return successRes({ follow }, 'Follow request sent successfully');
    } catch (error) {
      return badRequestRes(error.message);
    }
  }

  @Put('/follow/approve-follow/:followId')
  @ApiOperation({ summary: 'Approve or reject a follow request' })
  @ApiParam({
    name: 'followId',
    type: String,
    description: 'Follow request ID',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['accepted', 'pending', 'rejected'],
          description: 'Set to "accepted" to approve, "rejected" to decline',
        },
      },
    },
  })
  async approveFollowRequest(
    @Param('followId') followId: string,
    @Body() { status }: { status: FollowStatus },
    @AuthUser() actor: IAuthUser,
  ) {
    try {
      const follow = await this.usersService.approveFollowRequest(
        followId,
        status,
        actor.id,
      );
      return successRes({ follow }, 'Follow request processed successfully');
    } catch (error) {
      return badRequestRes(error.message);
    }
  }

  @Delete('/follow/unfollow/:userId')
  @ApiOperation({ summary: 'Unfollow a user' })
  @ApiParam({ name: 'userId', type: String, description: 'User to unfollow' })
  async unfollowUser(
    @Param('userId') userId: string,
    @AuthUser() authUser: IAuthUser,
  ) {
    try {
      const unfollow = await this.usersService.unfollowUser(
        authUser.id,
        userId,
      );
      return successRes({ unfollow }, 'Successfully unfollowed user');
    } catch (error) {
      return badRequestRes(error.message);
    }
  }

  @Get('/follow/follow-requests')
  @ApiOperation({ summary: 'Get all follow requests for the user' })
  async getFollowRequests(@AuthUser() authUser: IAuthUser) {
    const followRequests = await this.usersService.getFollowRequests(
      authUser.id,
    );
    return successRes({ followRequests });
  }

  @Get('/follow/followers')
  @ApiOperation({ summary: 'Get all followers of the current user' })
  async getFollowers(@AuthUser() authUser: IAuthUser) {
    const followers = await this.usersService.getFollowers(authUser.id);
    return successRes({ followers });
  }

  @Get('/follow/following')
  @ApiOperation({ summary: 'Get all users the current user is following' })
  async getFollowing(@AuthUser() authUser: IAuthUser) {
    const following = await this.usersService.getFollowing(authUser.id);
    return successRes({ following });
  }

  @UseGuards(RolesGuard)
  @Roles(ERole.ADMIN)
  @Put('verify/:id')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        isEmailVerified: {
          type: 'boolean',
        },
      },
    },
  })
  @ApiOperation({ summary: 'Admin updates the email verification status' })
  @ApiResponse({
    status: 200,
    description: 'Email verification status updated successfully.',
    schema: {
      example: successRes({ message: 'Email verified successfully' }),
    },
  })
  @ApiResponse({
    status: 400,
    description: 'User not found or invalid status.',
    schema: {
      example: badRequestRes('Invalid user ID or status'),
    },
  })
  async verifyEmailStatus(
    @Param('id') _id: string,
    @Body() body: { isEmailVerified: boolean },
  ) {
    const { isEmailVerified } = body;

    const updatedUser = await this.usersService.updateEmailVerificationStatus(
      _id,
      isEmailVerified,
    );

    const url = `${process.env.PUBLIC_SITE_DOMAIN}/signin`;
    const status = isEmailVerified == true ? 'accepted' : 'not accepted';

    //TODO: Send email here
    const sendEmail = await this.mailService.verifyAccountByAdmin(
      updatedUser.username,
      updatedUser.firstName,
      status,
      url,
    );

    if (!sendEmail) return badRequestRes(`Unable to verification email`);

    return updatedUser
      ? successRes({
          message: 'Email verification status updated successfully',
        })
      : badRequestRes('User not found or invalid status');
  }

  @UseGuards(RolesGuard)
  @Roles(ERole.ADMIN)
  @Put('block/:id')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        isBlocked: {
          type: 'boolean',
        },
      },
    },
  })
  @ApiOperation({ summary: 'Admin updates the isBlocked status' })
  @ApiResponse({
    status: 200,
    description: 'isBlocked status updated successfully.',
    schema: {
      example: successRes({ message: 'Email verified successfully' }),
    },
  })
  @ApiResponse({
    status: 400,
    description: 'User not found or invalid status.',
    schema: {
      example: badRequestRes('Invalid user ID or status'),
    },
  })
  async isBlockedStatus(
    @Param('id') _id: string,
    @Body() body: { isBlocked: boolean },
  ) {
    const { isBlocked } = body;

    const updatedUser = await this.usersService.updateIsBlockedStatus(
      _id,
      isBlocked,
    );

    return updatedUser
      ? successRes({ message: 'isBlocked status updated successfully' })
      : badRequestRes('User not found or invalid status');
  }
}
