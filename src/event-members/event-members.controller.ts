import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Patch,
  Delete,
  BadRequestException,
  UseGuards,
  Put,
} from '@nestjs/common';
import { EventMembersService } from './event-members.service';
import { CreateEventMemberRequestDto } from './dto/create-event-member.dto';
import { UpdateEventMemberDto } from './dto/update-event-member.dto';
import { ApiBearerAuth, ApiTags, ApiOperation, ApiResponse, ApiParam, ApiBody } from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/common/guards';
import { EventRequestStatus } from 'src/common/schemas/event-members.schema';
import { successRes } from 'src/common/interceptors';
import { AuthUser } from 'src/common/decorators';
import { IAuthUser } from 'src/common/interfaces';

@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@ApiTags('Event Members')
@Controller('event-members')
export class EventMembersController {
  constructor(private readonly eventMembersService: EventMembersService) {}

  @Post('join')
  @ApiOperation({ summary: 'Send a join request to an event' })
  @ApiBody({
    description: 'Request body for sending a join request to an event',
    type: CreateEventMemberRequestDto,
  })
  @ApiResponse({
    status: 201,
    description: 'Request to join event created successfully.',
  })
  @ApiResponse({
    status: 400,
    description: 'Event not found or user has already sent a request.',
  })
  async sendJoinRequest(
    @Body() createEventMemberRequestDto: CreateEventMemberRequestDto,
  ) {
    const eventMemeber = await this.eventMembersService.sendJoinRequest(createEventMemberRequestDto);
    return successRes(eventMemeber);
  }

  @Get(':eventId/participants')
  @ApiOperation({ summary: 'Get all participants of an event' })
  @ApiParam({ name: 'eventId', description: 'ID of the event' })
  @ApiResponse({
    status: 200,
    description: 'List of participants retrieved successfully.',
  })
  @ApiResponse({
    status: 404,
    description: 'Event not found.',
  })
  async getParticipants(@Param('eventId') eventId: string) {
    const participants = await this.eventMembersService.getParticipants(eventId);
    return successRes({ participants });
  }

  @ApiBody({
    description: 'Request body for updating the event member status',
    type: UpdateEventMemberDto,
  })
  @Put(':id/status')
  @ApiOperation({ summary: 'Accept or reject a join request for an event' })
  @ApiParam({ name: 'id', description: 'ID of the event member request' })
  @ApiResponse({
    status: 200,
    description: 'Join request status updated successfully.',
  })
  @ApiResponse({
    status: 400,
    description: 'Request not found or already accepted/rejected.',
  })
  async updateEventStatus(
    @Param('id') id: string,
    @Body() updateEventMemberDto: UpdateEventMemberDto,
    @AuthUser() user: IAuthUser,
  ) {
    const userId = user.id;

  const updateEventMemberStatusData = await this.eventMembersService.update(id, updateEventMemberDto, userId);
  return successRes(updateEventMemberStatusData);
  }
  

  @Delete(':id')
  @ApiOperation({ summary: 'Remove a member from an event' })
  @ApiParam({ name: 'id', description: 'ID of the event member to remove' })
  @ApiResponse({
    status: 200,
    description: 'Member removed from the event successfully.',
  })
  @ApiResponse({
    status: 404,
    description: 'Event member not found.',
  })
  async removeMember(
    @Param('id') id: string,
    @AuthUser() user: IAuthUser,
  ) {
    return this.eventMembersService.removeMember(id, user.id);
  }

  @Get(':eventId/requests/pending')
  @ApiOperation({ summary: 'Get all pending requests for a particular event from the event creator' })
  @ApiParam({ name: 'eventId', description: 'ID of the event' })
  @ApiResponse({
    status: 200,
    description: 'List of pending join requests for the event.',
  })
  @ApiResponse({
    status: 404,
    description: 'Event not found or you are not the creator of the event.',
  })
  async getPendingRequests(
    @Param('eventId') eventId: string,
    @AuthUser() user: IAuthUser,
  ) {
    const pendingRequests = await this.eventMembersService.getPendingRequestsForCreator(eventId, user.id);
    return successRes({ pendingRequests });
  }
}
