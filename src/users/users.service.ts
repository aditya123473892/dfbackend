import { BadRequestException, Injectable } from '@nestjs/common';
import { authorizeRoleGrant, changeRoles, protectLastRoot, validateRoles } from './role-policy';
import { preservationGate } from '../reports/preservation';
import { BlockService } from '../user-blocks/block.service';
import { referenceId } from '../user-blocks/block-context';
import { visiblePostQuery } from '../user-blocks/visible-post';
import { ObjectId } from 'mongodb';
import { CreateUserDto, FilterUsersDto, UpdateUserDto } from './dtos';
import { InjectModel } from '@nestjs/mongoose';
import { Model, SortOrder } from 'mongoose';
import { Posts, Users, UsersDocument } from '../common/schemas';
import { EBlockedByEnum, ERole } from 'src/common/enums';
import { EJotFormStatus } from 'src/common/enums/users.enum';
import { UpdateUserProfileDto } from './dtos/update-user-profile.dto';
import { UserEditHistory } from 'src/common/schemas/user-profile-edit.schema';
import { ApproveUserRequestDto } from './dtos/approve-request.dto';
import { Follow, FollowStatus } from 'src/common/schemas/follow.schema';
import { EPostStatus } from 'src/common/enums/posts.enum';
import { EPostVisibility } from 'src/common/enums/posts.enum';
import {
  PostRequest,
  PostRequestDocument,
} from 'src/common/schemas/posts-request.schema';
import {
  UserBookMark,
  UserBookMarkDocument,
} from 'src/common/schemas/user-bookmark.schema';
import {
  ChatMessage,
  ChatMessageDocument,
} from 'src/common/schemas/chats.schema';

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(Users.name) private usersModel: Model<UsersDocument>,
    @InjectModel(UserEditHistory.name)
    private readonly userEditHistoryModel: Model<UserEditHistory>,
    @InjectModel(Follow.name) private followModel: Model<Follow>,
    @InjectModel(Posts.name) private postModel: Model<Posts>,
    @InjectModel(PostRequest.name)
    private PostRequestModel: Model<PostRequestDocument>,
    @InjectModel(UserBookMark.name)
    private BookMarkModel: Model<UserBookMarkDocument>,
    @InjectModel(ChatMessage.name)
    private chatMessageModel: Model<ChatMessageDocument>,
    private readonly blocks: BlockService,
  ) {}

  async findByUsername(username: string) {
    return await this.usersModel.findOne({
      username,
    });
  }

  async findByVerifiedPhone(phoneE164: string) {
    return await this.usersModel.findOne({
      phoneE164,
      phoneVerifiedAt: { $ne: null },
    });
  }

  /** Raw driver read: viewer blocks and restrictions must not hide an existing owner. */
  async phoneOwnerId(phoneE164: string): Promise<string | null> {
    const owner = await this.usersModel.collection.findOne(
      { phoneE164 },
      { projection: { _id: 1 } },
    );
    return owner ? String(owner._id) : null;
  }

  /** Links a number already proven by OTP. Returns false when another account holds it. */
  async setVerifiedPhone(_id: string, phoneE164: string): Promise<boolean> {
    const owner = await this.phoneOwnerId(phoneE164);
    if (owner && owner !== String(_id)) return false;
    try {
      await this.updateOne(_id, { phoneE164, phoneVerifiedAt: new Date() });
      return true;
    } catch (error) {
      if (error?.code === 11000 && error?.keyPattern?.phoneE164) return false;
      throw error;
    }
  }

  async create(createUserDto: CreateUserDto, actorId?: string) {
    if ('premiumUntil' in createUserDto) throw new BadRequestException('Entitlements are server managed');
    validateRoles(createUserDto.roles);
    if (actorId) await authorizeRoleGrant(this.usersModel.db, actorId, createUserDto.roles);
    else if (createUserDto.roles.some((role) => role !== ERole.USER))
      throw new BadRequestException('Staff creation requires an authorized actor');
    const createUser = new this.usersModel(createUserDto);

    return await createUser.save();
  }

  async updateOne(
    _id: string,
    updateUserDto: Partial<UpdateUserDto> & Record<string, any>,
    actorId?: string,
  ): Promise<UsersDocument | null> {
    return preservationGate(this.usersModel.db, async () => {
    if ('premiumUntil' in updateUserDto) throw new BadRequestException('Entitlements are server managed');
    if (Object.keys(updateUserDto).some((key) => key.startsWith('$') || key.includes('.')))
      throw new BadRequestException('Invalid update fields');
    if (updateUserDto.isBlocked === true || updateUserDto.deletionRequestedAt || new Date(updateUserDto.moderationSuspendedUntil) > new Date())
      await protectLastRoot(this.usersModel.db, _id);
    if (Object.prototype.hasOwnProperty.call(updateUserDto, 'roles')) {
      await changeRoles(this.usersModel.db, actorId, _id, updateUserDto.roles);
      updateUserDto = { ...updateUserDto };
      delete updateUserDto.roles;
    }
    const updateFields = {};
    Object.keys(updateUserDto).forEach((key) => {
      if (updateUserDto[key] !== undefined) {
        updateFields[key] = updateUserDto[key];
      }
    });

    const updatedUser = await this.usersModel
      .findOneAndUpdate({ _id }, { $set: updateFields }, { new: true, runValidators: true })
      .exec();

    return updatedUser;
    });
  }

  async findAll(params: FilterUsersDto) {
    const query = this.usersModel.find();

    // Apply search condition based on ownerType
    if (params.name) {
      const regex = new RegExp(params.name.replace(/\s+/g, '\\s+'), 'i');
      query.where('name').equals(regex);
    }

    if (params.displayname) {
      const regex = new RegExp(params.displayname.replace(/\s+/g, '\\s+'), 'i');
      query.where('displayname').equals(regex);
    }

    if (params.city) {
      const regex = new RegExp(params.city.replace(/\s+/g, '\\s+'), 'i');
      query.where('city').equals(regex);
    }

    if (params.state) {
      const regex = new RegExp(params.state.replace(/\s+/g, '\\s+'), 'i');
      query.where('state').equals(regex);
    }

    if (params.country) {
      const regex = new RegExp(params.country.replace(/\s+/g, '\\s+'), 'i');
      query.where('country').equals(regex);
    }

    if (params.sortBy && params.order) {
      const sortOrder = params.order === 'desc' || params.order === -1 ? -1 : 1;
      const sortOptions: { [key: string]: SortOrder } = {
        [params.sortBy]: sortOrder,
      };
      query.sort(sortOptions);
    }

    // Add pagination
    if (params.limit) {
      query.limit(params.limit);
    }

    if (params.skip) {
      query.skip(params.skip);
    }

    const users = await query.exec();
    const count = await this.usersModel.countDocuments(query.getQuery());

    const usersWithPosts = await Promise.all(
      users.map(async (user) => {
        const userPosts = await visiblePostQuery(
          this.postModel.find({
            user: user._id,
            visibility: EPostVisibility.PUBLIC,
            status: EPostStatus.APPROVED,
          }),
        ).exec();

        return {
          ...user.toObject(),
          usersPost: userPosts,
        };
      }),
    );

    return { users: usersWithPosts, count };
  }

  async findById(_id: string) {
    const user = await this.usersModel.findById(_id);

    if (!user) return null;

    const userPosts = await visiblePostQuery(
      this.postModel.find({
        user: _id,
        visibility: EPostVisibility.PUBLIC,
        status: EPostStatus.APPROVED,
      }),
    ).exec();

    return {
      ...user.toObject(),
      usersPost: userPosts,
    };
  }

  async findByIdWithUserPost(id: string, viewerId?: string) {
    const user = await this.usersModel.findById(id);
    if (!user) return null;
    const today = new Date();
    const hasAccess = await this.PostRequestModel.findOne({
      userId: id,
      requestedUserId: viewerId,
      status: 'accepted',
      startTime: { $lte: today },
      endTime: { $gte: today },
    });

    let query: any;

    if (hasAccess) {
      query = {
        $or: [
          {
            user: id,
            visibility: EPostVisibility.PUBLIC,
            status: EPostStatus.APPROVED,
          },
          {
            user: id,
            visibility: EPostVisibility.PRIVATE,
            status: EPostStatus.APPROVED,
          },
        ],
      };
    } else {
      query = {
        user: id,
        visibility: EPostVisibility.PUBLIC,
        status: EPostStatus.APPROVED,
      };
    }

    const userPosts = await visiblePostQuery(this.postModel.find(query)).exec();

    return {
      ...user.toObject(),
      usersPost: userPosts,
    };
  }

  async findOne(payload: any) {
    return await this.usersModel.findOne(payload);
  }

  async updateLoginInfo(id: string): Promise<any> {
    return await this.usersModel.updateOne(
      { _id: id },
      { $inc: { loginCount: 1 }, loginAttempts: 0 },
    );
  }

  async updateLoginAttempts(id: string, loginAttempts: number): Promise<any> {
    let update = await this.usersModel.updateOne(
      { _id: id },
      { $set: { loginAttempts: loginAttempts } },
    );

    return update;
  }

  async blockUserBySystem(id: string): Promise<any> {
    return await this.usersModel.updateOne(
      { _id: id },
      {
        $set: {
          blockedBy: EBlockedByEnum.SYSTEM,
          blockedTime: new Date(),
          loginAttempts: 3,
        },
      },
    );
  }

  async findOneWithPassword(username: string): Promise<UsersDocument | null> {
    return await this.usersModel
      .findOne({ username: username })
      .select('password roles username isBlocked moderationSuspendedUntil deletionRequestedAt');
  }

  async updatePassword(
    _id: string,
    password: string,
  ): Promise<UsersDocument | null> {
    let user = await this.usersModel.findById(_id);
    user.password = password;
    ((user.passwordResetTokenUsed = true), (user.passwordResetToken = null));
    return await user.save();
  }

  async updateJotformAPIKey(
    _id: string,
    jotformAPIKey: string,
    jotformStatus: EJotFormStatus,
  ) {
    return await this.usersModel.updateOne(
      { _id },
      { $set: { jotformAPIKey, jotformStatus } },
    );
  }

  async findOneWithJotformAPIKey(_id: string) {
    return await this.usersModel
      .findOne({ _id })
      .select('jotformStatus jotformAPIKey');
  }

  async updateOneUserProfile(
    _id: string,
    updateUserDto: UpdateUserProfileDto,
  ): Promise<UsersDocument | null> {
    if ('premiumUntil' in updateUserDto) throw new BadRequestException('Entitlements are server managed');
    const updateFields: Record<string, any> = {};

    Object.entries(updateUserDto).forEach(([key, value]) => {
      if (value !== undefined) {
        if (key === 'intrests') {
          if (typeof value === 'string') {
            updateFields[key] = value.split(',').map((item) => item.trim());
          } else if (Array.isArray(value)) {
            updateFields[key] = value.map((item) => item.trim());
          }
        } else {
          updateFields[key] = value;
        }
      }
    });

    const updatedUser = await this.usersModel
      .findOneAndUpdate(
        { _id },
        { $set: { ...updateFields, canEditProfile: false } },
        { new: true },
      )
      .exec();

    return updatedUser;
  }

  async createUserEditHistory(userId: string, remark: string) {
    const userEditHistory = new this.userEditHistoryModel({
      user: userId,
      remark,
      isAdminRequest: false,
    });
    return await userEditHistory.save();
  }

  async getUserBookMark(userId: string) {
    const bookMark = await this.BookMarkModel.find({
      userId,
      status: true,
    }).populate('bookMarkUser');
    if (!bookMark) {
      return null;
    }
    return bookMark;
  }

  async userBookMark(userId: string, bookMarkUserId: string) {
    const user = await this.usersModel.findOne({ _id: bookMarkUserId });
    if (!user) {
      throw new Error('User not found');
    }

    const existingBookmark = await this.BookMarkModel.findOne({
      userId,
      bookMarkUser: bookMarkUserId,
    });

    if (existingBookmark) {
      throw new Error('User already bookmarked');
    }

    const newBookmark = new this.BookMarkModel({
      userId,
      bookMarkUser: bookMarkUserId,
      status: true,
    });

    const result = await newBookmark.save();

    if (!result) {
      throw new Error('Failed to create bookmark');
    }

    return result;
  }

  async updateBookMarkStatus(userId: string, bookMarkUserId: string) {
    const existingBookmark = await this.BookMarkModel.findOne({
      userId,
      bookMarkUser: bookMarkUserId,
    });

    if (!existingBookmark) {
      throw new Error('Bookmark not found');
    }

    existingBookmark.status = !existingBookmark.status;

    const updatedResult = await existingBookmark.save();

    if (!updatedResult) {
      throw new Error('Failed to update bookmark status');
    }

    return updatedResult;
  }

  async getUserEditHistoryByUserIdAndStatus(
    userId: string,
    isAdminRequest: boolean,
  ) {
    try {
      return await this.userEditHistoryModel.findOne({
        user: userId,
        isAdminRequest,
      });
    } catch (error) {
      console.error('Error fetching user edit history:', error);
      throw new Error('Error fetching user edit history');
    }
  }

  async getAllUserEditHistory(isAdminRequest: boolean) {
    try {
      return await this.userEditHistoryModel
        .find({ isAdminRequest })
        .populate('user', 'displayname avatar')
        .exec();
    } catch (error) {
      console.error('Error fetching user edit history:', error);
      throw new Error('Error fetching user edit history');
    }
  }

  async approveUserEditRequest(
    userId: string,
    approveUserRequestDto: ApproveUserRequestDto,
  ): Promise<UsersDocument | null> {
    const user = await this.usersModel.findById(userId);
    if (!user) {
      throw new Error('User not found');
    }

    const userEditHistory = await this.userEditHistoryModel.findOne({
      user: userId,
      isAdminRequest: false,
    });
    if (!userEditHistory) {
      throw new Error('No pending request found for this user');
    }

    userEditHistory.isAdminRequest = true;
    await userEditHistory.save();

    user.canEditProfile = approveUserRequestDto.status;
    await user.save();

    return user;
  }

  async sendFollowRequest(
    followerId: string,
    followingId: string,
  ): Promise<Follow> {
    if (
      !ObjectId.isValid(followingId) ||
      !(await this.usersModel.exists({ _id: followingId }))
    )
      throw new Error('User not found!');
    await this.blocks.assertVisible(followerId, followingId);
    const existingFollow = await this.followModel.findOne({
      follower: followerId,
      following: followingId,
    });
    if (existingFollow) {
      throw new Error('Follow request already sent or relationship exists');
    }

    const follow = new this.followModel({
      follower: followerId,
      following: followingId,
      status: FollowStatus.PENDING,
    });
    const saved = await follow.save();
    if (await this.blocks.isBlockedEitherWay(followerId, followingId)) {
      await this.followModel.updateOne(
        { _id: saved._id, status: FollowStatus.PENDING },
        { $set: { status: FollowStatus.REJECTED } },
      );
      throw new Error('User not found!');
    }
    return saved;
  }

  async approveFollowRequest(
    followId: string,
    status: FollowStatus,
    actorId: string,
  ): Promise<Follow> {
    const follow = await this.followModel.findById(followId);
    if (
      !follow ||
      String(follow.following) !== actorId ||
      follow.status !== FollowStatus.PENDING
    ) {
      throw new Error('Follow request not found');
    }

    if (![FollowStatus.ACCEPTED, FollowStatus.REJECTED].includes(status))
      throw new Error('Invalid follow status');
    await this.blocks.assertVisible(actorId, String(follow.follower));
    const updated = await this.followModel.findOneAndUpdate(
      { _id: followId, following: actorId, status: FollowStatus.PENDING },
      { $set: { status } },
      { new: true },
    );
    if (!updated) throw new Error('Follow request not found');
    await this.blocks.assertVisible(actorId, String(follow.follower));
    return updated;
  }

  async unfollowUser(followerId: string, followingId: string): Promise<Follow> {
    const follow = await this.followModel.findOneAndDelete({
      follower: followerId,
      following: followingId,
    });
    if (!follow) {
      throw new Error('Follow relationship not found');
    }

    return follow;
  }

  async getFollowRequests(userId: string): Promise<Follow[]> {
    return await this.followModel
      .find({
        following: userId,
        status: FollowStatus.PENDING,
      })
      .populate({
        path: 'follower',
        select: 'username displayname avatar',
      })
      .populate({
        path: 'following',
        select: 'username displayname avatar',
      });
  }

  async getFollowing(userId: string): Promise<UsersDocument[]> {
    const follows = await this.followModel.find({
      follower: userId,
      status: FollowStatus.ACCEPTED,
    });
    return this.usersModel.find({
      _id: { $in: follows.map((f) => f.following) },
    });
  }

  async getFollowers(userId: string): Promise<UsersDocument[]> {
    const follows = await this.followModel.find({
      following: userId,
      status: FollowStatus.ACCEPTED,
    });
    return this.usersModel.find({
      _id: { $in: follows.map((f) => f.follower) },
    });
  }

  async findUnverifiedUsers(): Promise<UsersDocument[]> {
    return await this.usersModel.find({ isEmailVerified: false }).exec();
  }

  async updateEmailVerificationStatus(
    _id: string,
    isEmailVerified: boolean,
  ): Promise<UsersDocument | null> {
    return await this.usersModel.findByIdAndUpdate(
      _id,
      { $set: { isEmailVerified } },
      { new: true },
    );
  }

  async updateIsBlockedStatus(
    _id: string,
    isBlocked: boolean,
  ): Promise<UsersDocument | null> {
    return preservationGate(this.usersModel.db, async () => {
    if (isBlocked) await protectLastRoot(this.usersModel.db, _id);
    return await this.usersModel.findByIdAndUpdate(
      _id,
      { $set: { isBlocked } },
      { new: true },
    );
    });
  }

  async findUsers() {
    const query = this.usersModel.find();
    return query;
  }

  async getRandomOnlineAdmin(): Promise<{ message?: string; admin?: Users }> {
    const onlineAdmins = await this.usersModel
      .find({ isOnline: true, roles: ERole.ADMIN })
      .exec();

    if (!onlineAdmins.length) {
      return { message: 'No online admin is available at the moment.' };
    }

    const randomAdmin =
      onlineAdmins[Math.floor(Math.random() * onlineAdmins.length)];
    return { admin: randomAdmin };
  }

  async getUserChatList(userId: string) {
    const userObjectId = new ObjectId(userId);

    const userChatList = await this.chatMessageModel.find({
      $or: [{ sender: referenceId(userId) }, { receiver: referenceId(userId) }],
    });

    const uniqueUsers = new Set<string>();

    userChatList.forEach((chat) => {
      if (chat.sender && chat.sender.toString() !== userId) {
        uniqueUsers.add(chat.sender.toString());
      }
      if (chat.receiver && chat.receiver.toString() !== userId) {
        uniqueUsers.add(chat.receiver.toString());
      }
    });

    // Fetch user details for the unique user IDs
    if (uniqueUsers.size === 0) return []; // No users found, return empty array

    const users = await this.usersModel
      .find({
        _id: { $in: Array.from(uniqueUsers).map((id) => new ObjectId(id)) },
      })
      .select('_id displayname avatar username');

    return users;
  }

  async findAdmin() {
    const query = this.usersModel.find({ roles: ERole.ADMIN });
    return query;
  }
}
