import { randomUUID } from 'crypto';
import { NotificationService } from '../notification/notification.service';
import { ENotificationType } from '../common/enums/notifications.enum';
import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { authorizeRoleGrant, changeRoles, protectLastRoot, validateRoles } from './role-policy';
import { preservationGate } from '../reports/preservation';
import { BlockService } from '../user-blocks/block.service';
import { referenceId } from '../user-blocks/block-context';
import { visiblePostQuery } from '../user-blocks/visible-post';
import { ObjectId } from 'mongodb';
import { CreateUserDto, FilterUsersDto, UpdateUserDto } from './dtos';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, SortOrder } from 'mongoose';
import { Posts, Users, UsersDocument } from '../common/schemas';
import { EBlockedByEnum, ERole } from 'src/common/enums';
import { EJotFormStatus } from 'src/common/enums/users.enum';
import { UpdateUserProfileDto } from './dtos/update-user-profile.dto';
import { UserEditHistory } from 'src/common/schemas/user-profile-edit.schema';
import { ApproveUserRequestDto } from './dtos/approve-request.dto';
import { Follow, FollowStatus } from 'src/common/schemas/follow.schema';
import { EPostStatus, EPostVisibility } from 'src/common/enums/posts.enum';
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

// Never returned by any user endpoint.
const SECRET_FIELDS = [
  'password',
  'passwordResetToken',
  'passwordResetTokenUsed',
  'verifyEmailToken',
  'loginAttempts',
];
// Returned only to the account itself and to admins.
const PRIVATE_FIELDS = [
  'username',
  'phoneNumber',
  'phoneE164',
  'phoneVerifiedAt',
  'loginCount',
  'lastLogin',
  'blockedBy',
  'blockedTime',
  'canEditProfile',
];
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const searchPattern = (value: string) =>
  new RegExp(escapeRegex(String(value).slice(0, 100)).replace(/\s+/g, '\\s+'), 'i');

/** Strips secrets always, and contact/account details unless self or admin. */
export function toUserResponse(user: any, viewer?: { id?: string; roles?: string[] }) {
  if (!user) return user;
  const source = user.toObject ? user.toObject() : { ...user };
  const self = !!viewer?.id && String(source._id) === String(viewer.id);
  const admin = !!viewer?.roles?.some((role) => role === ERole.ADMIN || role === ERole.ROOT);
  for (const field of SECRET_FIELDS) delete source[field];
  if (!self && !admin) for (const field of PRIVATE_FIELDS) delete source[field];
  return source;
}

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
    @Optional() private readonly notifications?: NotificationService,
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

  async findAll(params: FilterUsersDto, viewerId?: string) {
    const query = this.usersModel.find();

    // Search input is escaped: it is matched literally, never as a pattern.
    if (params.name) {
      const regex = searchPattern(params.name);
      query.or([{ displayname: regex }, { firstName: regex }, { lastName: regex }]);
    }

    if (params.displayname) {
      query.where('displayname').equals(searchPattern(params.displayname));
    }

    if (params.city) {
      query.where('city').equals(searchPattern(params.city));
    }

    if (params.state) {
      query.where('state').equals(searchPattern(params.state));
    }

    if (params.country) {
      query.where('country').equals(searchPattern(params.country));
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

    query.limit(Math.min(50, Math.max(1, Number(params.limit) || 20)));
    const users = await query.exec();
    const count = await this.usersModel.countDocuments(query.getQuery());

    const profiles = await this.socialProfiles(users, viewerId);
    if (params.summary === 'true') return { users: profiles, count };
    // Preserve the legacy full response; mobile Discover requests summaries.
    const posts = await visiblePostQuery(this.postModel.find({
      user: { $in: profiles.filter(u => u.isPrivate !== true || String(u._id) === viewerId ||
        u.relationship.status === 'following').map(u => u._id) }, visibility: EPostVisibility.PUBLIC,
      status: EPostStatus.APPROVED,
    })).lean().exec();
    const byUser = new Map<string, any[]>();
    for (const post of posts) {
      const key = String(post.user);
      if (!byUser.has(key)) byUser.set(key, []);
      byUser.get(key).push(post);
    }
    return { users: profiles.map(user => ({
      ...user, usersPost: byUser.get(String(user._id)) || [],
    })), count };
  }

  /** Counts always come from accepted edges, never stale imported counters. */
  async socialProfiles(users: any[], viewerId?: string) {
    if (!users.length) return users;
    const ids = users.map(u => new ObjectId(String(u._id)));
    const [incoming, outgoing, relations] = await Promise.all([
      this.followModel.aggregate([{ $match: { following: { $in: ids }, status: 'accepted' } },
        { $group: { _id: '$following', count: { $sum: 1 } } }]),
      this.followModel.aggregate([{ $match: { follower: { $in: ids }, status: 'accepted' } },
        { $group: { _id: '$follower', count: { $sum: 1 } } }]),
      viewerId ? this.followModel.find({ follower: viewerId, following: { $in: ids },
        status: { $in: ['pending', 'accepted'] } }).lean() : [],
    ]);
    const counts = (rows: any[]) => new Map(rows.map(row => [String(row._id), row.count]));
    const followers = counts(incoming), following = counts(outgoing);
    const edges = new Map<string, any>(relations.map(row => [String(row.following), row] as [string, any]));
    return users.map(source => {
      const user = source.toObject ? source.toObject() : source;
      const id = String(user._id), edge = edges.get(id);
      return { ...user, followers: followers.get(id) || 0, following: following.get(id) || 0,
        relationship: { status: edge?.status === 'accepted' ? 'following' : edge?.status === 'pending' ? 'requested' : 'none',
          ...(edge ? { requestId: String(edge._id) } : {}) } };
    });
  }

  async relationship(viewer: string, target: string) {
    if (!ObjectId.isValid(target)) throw new BadRequestException('Invalid user');
    await this.blocks.assertVisible(viewer, target);
    const user = await this.usersModel.findById(target);
    if (!user) throw new BadRequestException('User not found');
    return (await this.socialProfiles([user], viewer))[0].relationship;
  }

  async followCounts(userId: string) {
    const [followers, following] = await Promise.all([
      this.followModel.countDocuments({ following: userId, status: FollowStatus.ACCEPTED }),
      this.followModel.countDocuments({ follower: userId, status: FollowStatus.ACCEPTED }),
    ]);
    return { followers, following };
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
      ...(await this.socialProfiles([user], _id))[0],
      usersPost: userPosts,
    };
  }

  /**
   * A profile with the posts the viewer may see. The owner sees all of their
   * posts; others see approved public posts, plus approved private posts
   * while an accepted post request grants access.
   */
  async findByIdWithUserPost(id: string, viewerId?: string) {
    if (!ObjectId.isValid(id)) return null;
    const user = await this.usersModel.findById(id);
    if (!user) return null;
    if (viewerId && String(viewerId) === String(id)) {
      return {
        ...(await this.socialProfiles([user], viewerId))[0],
        usersPost: await this.postModel
          .find({ user: id })
          .sort({ createdAt: -1 })
          .populate({ path: 'likes', select: 'user' })
          .exec(),
      };
    }
    const today = new Date();
    if (user.isPrivate === true && !await this.followModel.exists({
      follower: viewerId, following: id, status: FollowStatus.ACCEPTED,
    })) return { ...(await this.socialProfiles([user], viewerId))[0], usersPost: [] };
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
      ...(await this.socialProfiles([user], viewerId))[0],
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

  /** Authentication metadata does not change reportable profile content. */
  async markEmailVerified(id: string): Promise<UsersDocument> {
    return this.usersModel.findOneAndUpdate(
      { _id: id }, { $set: { isEmailVerified: true } }, { new: true, runValidators: true },
    ).exec();
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

  async sendFollowRequest(followerId: string, followingId: string): Promise<Follow> {
    const saved = await this.followTransaction(session => this.writeFollowRequest(followerId, followingId, session));
    this.notifications?.socialChanged(followerId, followingId);
    return saved;
  }

  /** Retry pair-index races in a fresh transaction; never read from an aborted transaction. */
  private async followTransaction<T>(write: (session: ClientSession) => Promise<T>): Promise<T> {
    const deadline = Date.now() + 10_000;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.followModel.db.transaction(session => {
          if (Date.now() >= deadline) throw new Error('Relationship transaction timed out');
          return write(session);
        }, { maxCommitTimeMS: 5000, readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
      } catch (error) {
        if (error?.code !== 11000 || attempt >= 2 || Date.now() >= deadline) throw error;
      }
    }
  }

  private async writeFollowRequest(followerId: string, followingId: string, session: ClientSession): Promise<Follow> {
    if (!ObjectId.isValid(followingId) || followerId === followingId)
      throw new BadRequestException('Invalid follow target');
    await this.blocks.assertVisible(followerId, followingId);
    const user = await this.usersModel.findById(followingId).select('isPrivate').session(session);
    if (!user) throw new BadRequestException('User not found');
    const status = user.isPrivate === false ? FollowStatus.ACCEPTED : FollowStatus.PENDING;
    const pair = { follower: followerId, following: followingId };
    // A conditional single-document write and unique pair index arbitrate concurrent callers.
    let saved = await this.followModel.findOne(pair).session(session);
    if (saved?.status === FollowStatus.REJECTED) saved = await this.followModel.findOneAndUpdate(
      { ...pair, status: FollowStatus.REJECTED }, { $set: { status, requestKey: randomUUID() } }, { new: true, session });
    if (!saved) {
      saved = await this.followModel.findOneAndUpdate(pair,
        { $setOnInsert: { ...pair, status, requestKey: randomUUID() } }, { upsert: true, new: true, session });
    }
    if (!saved) throw new BadRequestException('Follow changed; retry');
    if (await this.blocks.isBlockedEitherWay(followerId, followingId)) {
      throw new BadRequestException('User not found');
    }
    if (saved.status === FollowStatus.PENDING && this.notifications)
      await this.notifications.sendNotification(followingId, followerId, ENotificationType.FOLLOW_REQUEST,
        'New follow request', { navigation: { profileId: followerId, requestId: String(saved._id) } },
        'follow:' + saved._id + ':' + (saved.requestKey || 'legacy'), session);
    return saved;
  }

  async approveFollowRequest(followId: string, status: FollowStatus, actorId: string): Promise<Follow> {
    const updated = await this.followTransaction(session => this.writeFollowApproval(followId, status, actorId, session));
    this.notifications?.socialChanged(String(updated.follower), actorId);
    return updated;
  }

  private async writeFollowApproval(followId: string, status: FollowStatus, actorId: string, session: ClientSession): Promise<Follow> {
    if (!ObjectId.isValid(followId) || ![FollowStatus.ACCEPTED, FollowStatus.REJECTED].includes(status))
      throw new BadRequestException('Invalid follow request');
    const follow = await this.followModel.findOne({ _id: followId, following: actorId }).session(session);
    if (!follow) throw new BadRequestException('Follow request not found');
    await this.blocks.assertVisible(actorId, String(follow.follower));
    if (follow.status === status) {
      await this.notifyFollowAccepted(follow, actorId, session);
      return follow;
    }
    const updated = await this.followModel.findOneAndUpdate(
      { _id: followId, following: actorId, status: FollowStatus.PENDING },
      { $set: { status } }, { new: true, session });
    if (!updated) {
      const latest = await this.followModel.findOne({ _id: followId, following: actorId, status }).session(session);
      if (latest) { await this.notifyFollowAccepted(latest, actorId, session); return latest; }
      throw new BadRequestException('Follow request is no longer pending');
    }
    if (await this.blocks.isBlockedEitherWay(actorId, String(follow.follower))) {
      throw new BadRequestException('User not found');
    }
    await this.notifyFollowAccepted(updated, actorId, session);
    return updated;
  }

  private async notifyFollowAccepted(follow: any, actorId: string, session?: ClientSession) {
    if (follow.status === FollowStatus.ACCEPTED && this.notifications)
      await this.notifications.sendNotification(String(follow.follower), actorId, ENotificationType.FOLLOW_ACCEPTED,
        'Follow request accepted', { navigation: { profileId: actorId } }, 'accepted:' + follow._id + ':' + (follow.requestKey || 'legacy'), session);
  }

  async unfollowUser(followerId: string, followingId: string): Promise<Follow> {
    if (!ObjectId.isValid(followingId)) throw new BadRequestException('Invalid user');
    const removed = await this.followModel.findOneAndDelete({ follower: followerId, following: followingId });
    this.notifications?.socialChanged(followerId, followingId);
    return removed;
  }

  async cancelFollowRequest(actor: string, id: string) {
    if (!ObjectId.isValid(id)) throw new BadRequestException('Invalid request');
    const removed = await this.followModel.findOneAndDelete({ _id: id, follower: actor, status: FollowStatus.PENDING });
    if (removed) this.notifications?.socialChanged(actor, String(removed.following));
  }

  async getOutgoingRequests(userId: string) {
    return this.followModel.find({ follower: userId, status: FollowStatus.PENDING })
      .populate('following', 'displayname avatar firstName lastName').sort({ _id: -1 });
  }

  async getFollowRequests(userId: string): Promise<Follow[]> {
    return await this.followModel
      .find({
        following: userId,
        status: FollowStatus.PENDING,
      })
      .populate({
        path: 'follower',
        select: 'displayname avatar firstName lastName',
      })
      .populate({
        path: 'following',
        select: 'displayname avatar firstName lastName',
      });
  }

  async getFollowing(userId: string): Promise<UsersDocument[]> {
    const follows = await this.followModel.find({
      follower: userId,
      status: FollowStatus.ACCEPTED,
    });
    return this.socialProfiles(await this.usersModel.find({
      _id: { $in: follows.map((f) => f.following) },
    }), userId);
  }

  async getFollowers(userId: string): Promise<UsersDocument[]> {
    const follows = await this.followModel.find({
      following: userId,
      status: FollowStatus.ACCEPTED,
    });
    return this.socialProfiles(await this.usersModel.find({
      _id: { $in: follows.map((f) => f.follower) },
    }), userId);
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
      groupId: null,
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
      .select('_id displayname avatar username firstName lastName');

    return users;
  }

  async findAdmin() {
    const query = this.usersModel.find({ roles: ERole.ADMIN });
    return query;
  }
}
