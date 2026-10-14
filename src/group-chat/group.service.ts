import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Group, GroupDocument } from '../common/schemas/group-chat.schema';
import { CreateGroupDto } from './dtos/create-group.dto';
import { AddMembersDto } from './dtos/add-member.dto';
import { RemoveMembersDto } from './dtos/remove-member.dto';
import { UpdateGroupDto } from './dtos/update-group.dto';
const { ObjectId } = require('mongoose').Types;

@Injectable()
export class GroupService {
  constructor(
    @InjectModel(Group.name) private groupModel: Model<GroupDocument>,
  ) {}

  async createGroup(createGroupDto: CreateGroupDto, actorId: string): Promise<Group> {
    const { name, members } = createGroupDto;

    const allMembers = members.map((id) => new Types.ObjectId(id));
    const adminInobjectId = new Types.ObjectId(actorId);
    const uniqueMembers = Array.from(new Set([...allMembers, adminInobjectId]));

    const newGroup = new this.groupModel({
      name,
      admin: actorId,
      members: uniqueMembers,
    });
    return newGroup.save();
  }

  async addMembers(addMembersDto: AddMembersDto, actorId: string): Promise<Group> {
    const { groupId, members } = addMembersDto;

    const group = await this.groupModel.findById(groupId);
    if (!group) {
      throw new NotFoundException('Group not found');
    }
    this.assertAdmin(group, actorId);

    const memberObjectIds = members.map((member) => new Types.ObjectId(member));

    group.members = Array.from(
      new Set([
        ...group.members.map((m) => m.toString()),
        ...memberObjectIds.map((m) => m.toString()),
      ]),
    ).map((id) => new Types.ObjectId(id));

    return group.save();
  }

  async removeMembers(removeMembersDto: RemoveMembersDto, actorId: string): Promise<Group> {
    const { groupId, members } = removeMembersDto;

    const group = await this.groupModel.findById(groupId);
    if (!group) {
      throw new NotFoundException('Group not found');
    }
    this.assertAdmin(group, actorId);
    if (members.includes(String(group.admin))) {
      throw new ForbiddenException('The group owner cannot be removed');
    }

    group.members = group.members.filter(
      (member) => !members.includes(member.toString()),
    );

    return group.save();
  }

  async getGroupsForUser(userId: string) {
    const userObjectId = new ObjectId(userId);
    const allGroup = await this.groupModel
      .find({ members: userObjectId })
      .exec();
    return allGroup;
  }

  async updateGroup(
    groupId: string,
    updateGroupDto: UpdateGroupDto,
    actorId: string,
  ): Promise<Group> {
    const group = await this.groupModel.findById(groupId);
    if (!group) {
      throw new NotFoundException('Group not found');
    }
    this.assertAdmin(group, actorId);

    if (updateGroupDto.name) {
      group.name = updateGroupDto.name;
    }

    if (updateGroupDto.description) {
      group.description = updateGroupDto.description;
    }

    return group.save();
  }

  async findById(_id: string) {
    return await this.groupModel.findById(_id);
  }

  async uploadGroupIcon(groupId: string, groupIconUrl: string, actorId: string) {
    const group = await this.groupModel.findById(groupId);
    if (!group) {
      throw new NotFoundException('Group not found');
    }
    this.assertAdmin(group, actorId);

    group.groupIcon = groupIconUrl;
    return group.save();
  }
  async getGroupMembers(groupId: string, actorId: string) {
    const group = await this.groupModel
      .findById(groupId)
      .populate({
        path: 'members',
        model: 'Users',
        select: 'username displayname firstName lastName phoneNumber avatar',
      })
      .exec();
  
    if (!group) {
      throw new NotFoundException('Group not found');
    }
    const isMember = group.members.some((member: any) =>
      String(member?._id || member) === actorId,
    );
    if (!isMember) throw new ForbiddenException('Group membership required');
  
    return group;
  }

  private assertAdmin(group: GroupDocument, actorId: string) {
    if (String(group.admin) !== actorId) {
      throw new ForbiddenException('Only the group owner can perform this action');
    }
  }
  
}
