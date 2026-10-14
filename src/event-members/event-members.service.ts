import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { CreateEventMemberRequestDto } from './dto/create-event-member.dto';
import { EventMembers, EventMembersDocument } from 'src/common/schemas/event-members.schema';
import { Events, EventsDocument } from 'src/common/schemas/events.schema';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { EventRequestStatus } from 'src/common/schemas/event-members.schema';
import { badRequestRes } from 'src/common/interceptors';
import { UpdateEventMemberDto } from './dto/update-event-member.dto';
import { ENotificationType } from '../common/enums/notifications.enum';
import { NotificationService } from 'src/notification/notification.service';

@Injectable()
export class EventMembersService {
  constructor(
    @InjectModel(EventMembers.name)
    private eventsMembersModel: Model<EventMembersDocument>,
    @InjectModel(Events.name) private eventsModel: Model<EventsDocument>,
    private readonly notificationService: NotificationService,
  ) {}

  async sendJoinRequest(createEventMemberRequestDto: CreateEventMemberRequestDto): Promise<EventMembers> {
    const { user, event } = createEventMemberRequestDto;

    const eventData = await this.eventsModel.findById(event);
    if (!eventData) {
      throw new BadRequestException(`Event with ID- ${event} not found.`);
    }

    const existingRequest = await this.eventsMembersModel.findOne({
      user,
      event,
    });
    if (existingRequest) {
      throw new BadRequestException('You have already requested to join or are a member of this event.');
    }

    const newRequest = new this.eventsMembersModel(createEventMemberRequestDto);
    return await newRequest.save();
  }

  async getParticipants(eventId: string) {
    const participants = await this.eventsMembersModel
      .find({ event: eventId, requestStatus: EventRequestStatus.ACCEPTED })
      .populate('user');
    return participants;
  }

  async update(id: string, updateEventMemberDto: UpdateEventMemberDto, userId: string) {
    const updatedMember = await this.eventsMembersModel.findById(id).populate(['user', 'event']) as EventMembersDocument;
    let receiverId
    if (updatedMember.user && '_id' in updatedMember.user) {
      receiverId = updatedMember.user._id.toString();
    }
    let eventId
    if (updatedMember.event && '_id' in updatedMember.event) {
      eventId = updatedMember.event._id.toString();
    }

    if (!updatedMember) {
      throw new BadRequestException(`Event member with ID- ${id} not found.`);
    }

    const event = updatedMember.event as EventsDocument;
    if (event.creator.toString() !== userId) {
      throw new ForbiddenException('You do not have permission to update the status of this request.');
    }

    updatedMember.requestStatus = updateEventMemberDto.requestStatus;
    await updatedMember.save();

    const message = updateEventMemberDto.requestStatus === 'accepted'
      ? `Your request to join the event has been approved! 🎉`
      : `Unfortunately, your request to join the event was declined.😞`;

    await this.notificationService.sendNotification(
      receiverId,
      userId,
      ENotificationType.EVENT_MESSAGE,
      message,
      { eventId: eventId, requestStatus: updateEventMemberDto.requestStatus }
    );

    return updatedMember;
  }

  async removeMember(id: string, userId: string) {
    const updatedMember = await this.eventsMembersModel.findById(id).populate('event') as EventMembersDocument;

    if (!updatedMember) {
      throw new BadRequestException(`Event member with ID- ${id} not found.`);
    }

    const event = updatedMember.event as EventsDocument;
    if (event.creator.toString() !== userId) {
      throw new ForbiddenException('You do not have permission to update the status of this request.');
    }

    const eventMember = await this.eventsMembersModel.findByIdAndDelete(id);
    if (!eventMember) {
      throw new BadRequestException(`Event member with ID- ${id} not found.`);
    }
    return { message: 'Member removed successfully from the event!' };
  }

  async getPendingRequestsForCreator(eventId: string, creatorId: string) {
    const event = await this.eventsModel.findOne({ _id: eventId, creator: creatorId });

    if (!event) {
      throw new BadRequestException(`Event with ID- ${eventId} not found or you are not the creator.`);
    }

    const pendingRequests = await this.eventsMembersModel
      .find({ event: eventId, requestStatus: EventRequestStatus.PENDING })
      .populate('user');

    return pendingRequests;
  }
}
