import {
  Controller,
  Post,
  Body,
  Get,
  UseGuards,
  Param,
  NotFoundException,
  Put,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
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
import { JwtAuthGuard, RolesGuard } from 'src/common/guards';
import { AuthUser, Roles } from 'src/common/decorators';
import { IAuthUser } from 'src/common/interfaces';
import { successGetRes } from 'src/common/interceptors/response.handlers';
import { UpdateGroupDto } from './dtos/update-group.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { S3BucketService } from 'src/s3-bucket/s3-bucket.service';
import { ERole } from 'src/common/enums';

@ApiTags('Groups')
@ApiBearerAuth()
@Controller('groups')
export class GroupController {
  constructor(
    private readonly groupService: GroupService,
    private readonly s3BucketService: S3BucketService,
  ) {}

  @Roles(ERole.ADMIN)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Post('create-group')
  @ApiOperation({ summary: 'Create a new group' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        admin: { type: 'string' },
        members: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'Group created successfully',
    type: Group,
  })
  @ApiResponse({ status: 400, description: 'Bad Request' })
  async createGroup(
    @Body() createGroupDto: CreateGroupDto,
    @AuthUser() user: IAuthUser,
  ) {
    const createGroup = await this.groupService.createGroup(createGroupDto, user.id);

    return successRes(createGroup);
  }

  @Roles(ERole.ADMIN)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Post('add-members')
  @ApiOperation({ summary: 'Add members into the group' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        groupId: { type: 'string' },
        members: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Members added successfully',
    type: Group,
  })
  @ApiResponse({ status: 400, description: 'Bad Request' })
  async addMembers(
    @Body() addMembersDto: AddMembersDto,
    @AuthUser() user: IAuthUser,
  ) {
    const addMembers = await this.groupService.addMembers(addMembersDto, user.id);

    return successRes(addMembers);
  }

  @Roles(ERole.ADMIN)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Post('remove-members')
  @ApiOperation({ summary: 'Remove members from the group' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        groupId: { type: 'string' },
        members: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Members removed successfully',
    type: Group,
  })
  @ApiResponse({ status: 400, description: 'Bad Request' })
  async removeMembers(
    @Body() removeMembersDto: RemoveMembersDto,
    @AuthUser() user: IAuthUser,
  ) {
    const removeMember =
      await this.groupService.removeMembers(removeMembersDto, user.id);

    return successRes(removeMember);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get('my-groups')
  @ApiResponse({
    status: 200,
    description: 'Returns all groups the user is a member of',
    type: [Group],
  })
  @ApiResponse({
    status: 404,
    description: 'No groups found for this user',
  })
  async getMyGroups(@AuthUser() user: IAuthUser) {
    const groups = await this.groupService.getGroupsForUser(user.id);

    return successGetRes(groups);
  }

  @Put(':groupId')
  @Roles(ERole.ADMIN)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @ApiOperation({ summary: 'Update group details' })
  @ApiBody({ type: UpdateGroupDto })
  @ApiResponse({
    status: 200,
    description: 'Group updated successfully',
    type: Group,
  })
  async updateGroup(
    @Param('groupId') groupId: string,
    @Body() updateGroupDto: UpdateGroupDto,
    @AuthUser() user: IAuthUser,
  ) {
    const updatedGroup = await this.groupService.updateGroup(
      groupId,
      updateGroupDto,
      user.id,
    );
    return successRes(updatedGroup);
  }

  @Put(':groupId/upload-icon')
  @Roles(ERole.ADMIN)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a group icon to S3' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        groupIcon: { type: 'string', format: 'binary' },
      },
    },
  })
  @UseInterceptors(FileInterceptor('groupIcon'))
  @ApiResponse({ status: 200, description: 'Group icon uploaded successfully' })
  async uploadGroupIcon(
    @Param('groupId') groupId: string,
    @UploadedFile() groupIcon: Express.Multer.File,
    @AuthUser() user: IAuthUser,
  ) {
    let avatarUrl: string | null = null;
    let oldAvatarKey: string | null = null;

    const groupData = await this.groupService.findById(groupId);
    if (!groupData || String(groupData.admin) !== user.id) {
      throw new NotFoundException('Group not found');
    }
    if (groupData && groupData.groupIcon) {
      oldAvatarKey = groupData.groupIcon.split('?')[0];
      oldAvatarKey = oldAvatarKey.split('/').pop();
    }

    if (groupIcon) {
      try {
        if (oldAvatarKey) {
          await this.s3BucketService.deleteOne(
            `groupIcon/${oldAvatarKey}`,
            process.env.AWS_DEFAULT_S3_BUCKET,
          );
        }

        const uploadResult = await this.s3BucketService.uploadFile(
          groupIcon,
          'groupIcon',
        );
        avatarUrl = await this.s3BucketService.getSignedURL(
          uploadResult.Key,
          process.env.AWS_DEFAULT_S3_BUCKET,
        );
      } catch (err) {
        throw new BadRequestException('Failed to upload avatar');
      }
    }

    const group = await this.groupService.uploadGroupIcon(groupId, avatarUrl, user.id);
    return successRes(group);
  }

  @Get(':groupId/members')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get all group members with details' })
  @ApiResponse({
    status: 200,
    description: 'Returns all group members with details',
  })
  async getGroupMembers(
    @Param('groupId') groupId: string,
    @AuthUser() user: IAuthUser,
  ) {
    const members = await this.groupService.getGroupMembers(groupId, user.id);
    return successGetRes(members);
  }
}
