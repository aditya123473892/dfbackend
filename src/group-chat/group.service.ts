import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Group, GroupDocument } from '../common/schemas/group-chat.schema';
import { Users, UsersDocument } from 'src/common/schemas';
import {
  anyId,
  ChatService,
  idForms,
  PUBLIC_USER_FIELDS,
} from 'src/chats/chats.service';
import { ChatGateway } from 'src/chats/chats.gateway';
import {
  CreateGroupDto,
  MAX_GROUP_DESCRIPTION_LENGTH,
  MAX_GROUP_MEMBERS,
  MAX_GROUP_NAME_LENGTH,
} from './dtos/create-group.dto';
import { AddMembersDto } from './dtos/add-member.dto';
import { RemoveMembersDto } from './dtos/remove-member.dto';
import { UpdateGroupDto } from './dtos/update-group.dto';
import { BlockService } from '../user-blocks/block.service';
import { preservationGate } from '../reports/preservation';
import { PhotosService } from '../photos/photos.service';

const uniqueIds = (ids: string[]) => [...new Set(ids.map(String))];

/**
 * Group conversations. The owner (`admin` field) manages metadata and
 * membership; every member can read and send. All checks run here, not only
 * in the client.
 */
@Injectable()
export class GroupService {
  constructor(
    @InjectModel(Group.name) private groupModel: Model<GroupDocument>,
    @InjectModel(Users.name) private usersModel: Model<UsersDocument>,
    private readonly chatService: ChatService,
    private readonly chatGateway: ChatGateway,
    private readonly blocks: BlockService,
    private readonly photos: PhotosService,
  ) {}

  async createGroup(dto: CreateGroupDto, actorId: string) {
    const name = this.validName(dto.name);
    const description = this.validDescription(dto.description);
    const memberIds = uniqueIds(dto.members || []).filter((id) => id !== actorId);
    if (!memberIds.length) throw new BadRequestException('Select at least one member');
    if (memberIds.length + 1 > MAX_GROUP_MEMBERS) {
      throw new BadRequestException(`Groups are limited to ${MAX_GROUP_MEMBERS} members`);
    }
    if (dto.clientId) {
      const existing = await this.groupModel.findOne({ admin: anyId(actorId), clientId: dto.clientId });
      if (existing) return this.toClientGroup(existing);
    }
    await this.assertUsersAvailable(memberIds);
    await this.assertStillVisible(actorId, memberIds);

    let group: GroupDocument;
    try {
      group = await this.groupModel.create({
        name,
        description,
        admin: new Types.ObjectId(actorId),
        members: [actorId, ...memberIds].map((id) => new Types.ObjectId(id)),
        clientId: dto.clientId,
      });
    } catch (error) {
      // A concurrent retry with the same clientId created the group first.
      if (error?.code === 11000 && dto.clientId) {
        const existing = await this.groupModel.findOne({ admin: anyId(actorId), clientId: dto.clientId });
        if (existing) return this.toClientGroup(existing);
      }
      throw error;
    }
    // A block committed between the check and the save must still win.
    try {
      await this.assertStillVisible(actorId, memberIds);
    } catch (error) {
      await this.groupModel.deleteOne({ _id: group._id });
      throw error;
    }
    const allMembers = [actorId, ...memberIds];
    await this.chatService.initializeGroupReadCursors(String(group._id), allMembers);
    this.chatGateway.syncGroupMembership(group, allMembers);
    return this.toClientGroup(group);
  }

  async addMembers(dto: AddMembersDto, actorId: string) {
    const group = await this.findOwnedGroup(dto.groupId, actorId);
    const current = new Set(group.members.map(String));
    const added = uniqueIds(dto.members).filter((id) => !current.has(id));
    if (!added.length) return this.toClientGroup(group);
    await this.assertUsersAvailable(added);
    await this.assertStillVisible(actorId, added);
    const maxCurrent = MAX_GROUP_MEMBERS - added.length;
    if (maxCurrent < 0) throw new BadRequestException(`Groups are limited to ${MAX_GROUP_MEMBERS} members`);
    // The size condition is part of the update so concurrent adds cannot
    // push the group past the limit.
    const updated = await this.groupModel.findOneAndUpdate(
      {
        _id: group._id,
        admin: anyId(actorId),
        [`members.${maxCurrent}`]: { $exists: false },
      },
      { $addToSet: { members: { $each: added.map((id) => new Types.ObjectId(id)) } } },
      { new: true },
    );
    if (!updated) throw new BadRequestException(`Groups are limited to ${MAX_GROUP_MEMBERS} members`);
    try {
      await this.assertStillVisible(actorId, added);
    } catch (error) {
      await this.groupModel.updateOne(
        { _id: group._id },
        { $pull: { members: { $in: idForms(added) } } },
      );
      throw error;
    }
    await this.chatService.initializeGroupReadCursors(String(updated._id), added);
    this.chatGateway.syncGroupMembership(updated, added);
    return this.toClientGroup(updated);
  }

  async removeMembers(dto: RemoveMembersDto, actorId: string) {
    return preservationGate(this.groupModel.db, async () => {
      const group = await this.findOwnedGroup(dto.groupId, actorId);
      const removed = uniqueIds(dto.members);
      if (removed.includes(String(group.admin))) {
        throw new ForbiddenException('The group owner cannot be removed');
      }
      await this.recordDepartures(group, removed);
      const updated = await this.groupModel.findOneAndUpdate(
        { _id: group._id, admin: anyId(actorId) },
        { $pull: { members: { $in: idForms(removed) } } },
        { new: true },
      );
      if (!updated) throw new NotFoundException('Group not found');
      await this.chatService.removeGroupReadCursors(String(updated._id), removed);
      this.blocks.groupRemoval$.next({ groupId: String(updated._id), members: removed });
      this.chatGateway.syncGroupMembership(updated, [], removed);
      return this.toClientGroup(updated);
    });
  }

  /**
   * A member leaves. When the owner leaves, ownership passes to the
   * longest-standing remaining member; the last member leaving deletes the group.
   */
  async leaveGroup(groupId: string, actorId: string) {
    return preservationGate(this.groupModel.db, async () => {
      const group = await this.findMemberGroup(groupId, actorId);
      const remaining = group.members.map(String).filter((id) => id !== actorId);
      if (!remaining.length) {
        await this.deleteOwnedGroup(group);
        return { groupId, left: true, deleted: true };
      }
      await this.recordDepartures(group, [actorId]);
      const update: any = { $pull: { members: { $in: idForms([actorId]) } } };
      if (String(group.admin) === actorId) update.$set = { admin: new Types.ObjectId(remaining[0]) };
      const updated = await this.groupModel.findOneAndUpdate(
        { _id: group._id, members: anyId(actorId) },
        update,
        { new: true },
      );
      if (!updated) throw new NotFoundException('Group not found');
      await this.chatService.removeGroupReadCursors(groupId, [actorId]);
      this.blocks.groupRemoval$.next({ groupId, members: [actorId] });
      this.chatGateway.syncGroupMembership(updated, [], [actorId]);
      return { groupId, left: true, deleted: false, admin: String(updated.admin) };
    });
  }

  async deleteGroup(groupId: string, actorId: string) {
    const group = await this.findOwnedGroup(groupId, actorId);
    await this.deleteOwnedGroup(group);
    return { groupId, deleted: true };
  }

  async getGroupsForUser(userId: string) {
    const groups = await this.groupModel.find({ members: anyId(userId) }).exec();
    return Promise.all(groups.map((group) => this.toClientGroup(group)));
  }

  async updateGroup(groupId: string, dto: UpdateGroupDto, actorId: string) {
    const group = await this.findOwnedGroup(groupId, actorId);
    if (dto.name !== undefined) group.name = this.validName(dto.name);
    if (dto.description !== undefined) group.description = this.validDescription(dto.description);
    await group.save();
    this.chatGateway.syncGroupMembership(group);
    return this.toClientGroup(group);
  }

  async findById(_id: string) {
    return Types.ObjectId.isValid(_id) ? this.groupModel.findById(_id) : null;
  }

  /** Sets the group image from an approved direct upload (owner only). */
  async uploadGroupIcon(groupId: string, uploadId: string, actorId: string) {
    const current = await this.findOwnedGroup(groupId, actorId);
    const ref = `group:${groupId}`;
    const [photo] = await this.photos.bind(actorId, [uploadId], ref);
    const group = await this.photos.replaceImage(
      'Groups',
      groupId,
      'groupIcon',
      current.groupIcon,
      photo.filename,
    );
    if (current.groupIcon && current.groupIcon !== photo.filename)
      await this.photos.retire(ref, [current.groupIcon]);
    this.chatGateway.syncGroupMembership({ ...group, members: current.members });
    return this.toClientGroup(group);
  }

  async getGroupMembers(groupId: string, actorId: string) {
    if (!Types.ObjectId.isValid(groupId)) throw new NotFoundException('Group not found');
    const group = await this.groupModel
      .findById(groupId)
      .populate({ path: 'members', model: 'Users', select: PUBLIC_USER_FIELDS })
      .exec();
    if (!group) throw new NotFoundException('Group not found');
    const isMember = group.members.some((member: any) => String(member?._id || member) === actorId);
    if (!isMember) throw new ForbiddenException('Group membership required');
    return this.toClientGroup(group);
  }

  /**
   * Response shape of a group. The `groupIcon` storage reference is signed by
   * PhotoResponseInterceptor; idempotency keys are never returned.
   */
  async toClientGroup(group: GroupDocument | any) {
    const source = group?.toObject ? group.toObject() : { ...group };
    const { groupIconKey, clientId, ...rest } = source;
    return { ...rest, groupIcon: source.groupIcon || groupIconKey };
  }

  private async deleteOwnedGroup(group: GroupDocument) {
    const groupId = String(group._id);
    await this.groupModel.deleteOne({ _id: group._id });
    await this.chatService.deleteGroupConversation(groupId);
    const icon = group.groupIcon || group.groupIconKey;
    if (icon) await this.photos.retire(`group:${groupId}`, [icon]);
    this.chatGateway.broadcastGroupDeleted(groupId);
  }

  /** Report evidence keeps which conversations a former member could read. */
  private async recordDepartures(group: GroupDocument, userIds: string[]) {
    if (!this.groupModel.db?.getClient) return;
    const groupId = String(group._id);
    for (const member of group.members.map(String)) {
      if (!userIds.includes(member)) continue;
      await this.groupModel.db.db.collection<any>('ReportMemberships').updateOne(
        { _id: `${groupId}:${member}` },
        { $set: { groupId, userId: member, leftAt: new Date() } },
        { upsert: true },
      );
    }
  }

  private async findMemberGroup(groupId: string, actorId: string) {
    if (!Types.ObjectId.isValid(groupId)) throw new NotFoundException('Group not found');
    const group = await this.groupModel.findById(groupId);
    if (!group) throw new NotFoundException('Group not found');
    if (!group.members.some((member) => String(member) === actorId)) {
      throw new ForbiddenException('Group membership required');
    }
    return group;
  }

  private async findOwnedGroup(groupId: string, actorId: string) {
    const group = await this.findMemberGroup(groupId, actorId);
    if (String(group.admin) !== actorId) {
      throw new ForbiddenException(
        'Only the group owner can perform this action',
      );
    }
    return group;
  }

  private async assertStillVisible(actorId: string, members: string[]) {
    for (const member of members)
      await this.blocks.assertVisible(actorId, member);
  }

  private async assertUsersAvailable(userIds: string[]) {
    const found = await this.usersModel.countDocuments({
      _id: { $in: userIds.map((id) => new Types.ObjectId(id)) },
      isBlocked: { $ne: true },
    });
    if (found !== userIds.length) throw new BadRequestException('Some selected users are unavailable');
  }

  private validName(value: unknown) {
    const name = typeof value === 'string' ? value.trim() : '';
    if (!name) throw new BadRequestException('Group name is required');
    if (name.length > MAX_GROUP_NAME_LENGTH) {
      throw new BadRequestException(`Group names are limited to ${MAX_GROUP_NAME_LENGTH} characters`);
    }
    return name;
  }

  private validDescription(value: unknown) {
    if (value === undefined || value === null) return undefined;
    const description = typeof value === 'string' ? value.trim() : '';
    if (description.length > MAX_GROUP_DESCRIPTION_LENGTH) {
      throw new BadRequestException(`Descriptions are limited to ${MAX_GROUP_DESCRIPTION_LENGTH} characters`);
    }
    return description;
  }
}
