import {
  Controller,
  Post,
  Body,
  Get,
  UseGuards,
  Param,
  Put,
  Delete,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { GroupService } from './group.service';
import { CreateGroupDto } from './dtos/create-group.dto';
import { Group } from '../common/schemas/group-chat.schema';
import { AddMembersDto } from './dtos/add-member.dto';
import { RemoveMembersDto } from './dtos/remove-member.dto';
import {
  ApiTags,
  ApiBody,
  ApiResponse,
  ApiOperation,
  ApiConsumes,
} from '@nestjs/swagger';
import { ApiBearerAuth } from '@nestjs/swagger';
import { successRes } from 'src/common/interceptors';
import { JwtAuthGuard } from 'src/common/guards';
import { AuthUser } from 'src/common/decorators';
import { IAuthUser } from 'src/common/interfaces';
import { successGetRes } from 'src/common/interceptors/response.handlers';
import { UpdateGroupDto } from './dtos/update-group.dto';
import { FileInterceptor } from '@nestjs/platform-express';

/**
 * Any authenticated user can create a group and becomes its owner. Membership
 * changes, metadata and deletion are restricted to the group owner; reading
 * requires membership. GroupService enforces these rules.
 */
@ApiTags('Groups')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('groups')
export class GroupController {
  constructor(private readonly groupService: GroupService) {}

  @Post('create-group')
  @ApiOperation({ summary: 'Create a new group owned by the caller' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        members: { type: 'array', items: { type: 'string' } },
        clientId: { type: 'string' },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Group created successfully', type: Group })
  @ApiResponse({ status: 400, description: 'Bad Request' })
  async createGroup(@Body() createGroupDto: CreateGroupDto, @AuthUser() user: IAuthUser) {
    return successRes(await this.groupService.createGroup(createGroupDto, user.id));
  }

  @Post('add-members')
  @ApiOperation({ summary: 'Add members to a group (owner only)' })
  async addMembers(@Body() addMembersDto: AddMembersDto, @AuthUser() user: IAuthUser) {
    return successRes(await this.groupService.addMembers(addMembersDto, user.id));
  }

  @Post('remove-members')
  @ApiOperation({ summary: 'Remove members from a group (owner only)' })
  async removeMembers(@Body() removeMembersDto: RemoveMembersDto, @AuthUser() user: IAuthUser) {
    return successRes(await this.groupService.removeMembers(removeMembersDto, user.id));
  }

  @Get('my-groups')
  @ApiResponse({ status: 200, description: 'Groups the caller is a member of', type: [Group] })
  async getMyGroups(@AuthUser() user: IAuthUser) {
    return successGetRes(await this.groupService.getGroupsForUser(user.id));
  }

  @Post(':groupId/leave')
  @ApiOperation({ summary: 'Leave a group; an owner hands ownership to the next member' })
  async leaveGroup(@Param('groupId') groupId: string, @AuthUser() user: IAuthUser) {
    return successRes(await this.groupService.leaveGroup(groupId, user.id));
  }

  @Delete(':groupId')
  @ApiOperation({ summary: 'Delete a group and its messages (owner only)' })
  async deleteGroup(@Param('groupId') groupId: string, @AuthUser() user: IAuthUser) {
    return successRes(await this.groupService.deleteGroup(groupId, user.id));
  }

  @Put(':groupId')
  @ApiOperation({ summary: 'Update group details (owner only)' })
  @ApiBody({ type: UpdateGroupDto })
  async updateGroup(
    @Param('groupId') groupId: string,
    @Body() updateGroupDto: UpdateGroupDto,
    @AuthUser() user: IAuthUser,
  ) {
    return successRes(await this.groupService.updateGroup(groupId, updateGroupDto, user.id));
  }

  @Put(':groupId/upload-icon')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a group image (owner only)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: { groupIcon: { type: 'string', format: 'binary' } },
    },
  })
  @UseInterceptors(FileInterceptor('groupIcon', { limits: { fileSize: 5 * 1024 * 1024 } }))
  async uploadGroupIcon(
    @Param('groupId') groupId: string,
    @UploadedFile() groupIcon: Express.Multer.File,
    @AuthUser() user: IAuthUser,
  ) {
    return successRes(await this.groupService.uploadGroupIcon(groupId, groupIcon, user.id));
  }

  @Get(':groupId/members')
  @ApiOperation({ summary: 'Get the group with its members (members only)' })
  async getGroupMembers(@Param('groupId') groupId: string, @AuthUser() user: IAuthUser) {
    return successGetRes(await this.groupService.getGroupMembers(groupId, user.id));
  }
}
