import { Injectable } from '@nestjs/common';
import { preserveMutation } from '../reports/preservation';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { Events, EventsDocument } from 'src/common/schemas/events.schema';
import { EventMembers, EventMembersDocument } from 'src/common/schemas/event-members.schema';
import { Model, SortOrder } from 'mongoose';
import { InjectModel } from '@nestjs/mongoose';
import { FilterEventDto } from './dto/filter-event.dto';
import { UploadEventCoverDto } from './dto/upload-event-cover.dto';
import { EventRequestStatus } from '../common/schemas/event-members.schema';

@Injectable()
export class EventsService {
  constructor(
    @InjectModel(Events.name) private eventsModel: Model<EventsDocument>,
    @InjectModel(EventMembers.name) private eventMembersModel: Model<EventMembersDocument>,
  ) {}

  async create(createEventDto: CreateEventDto): Promise<Events> {
    const event = new this.eventsModel(createEventDto);
    return await event.save();
  }

  async findAll(): Promise<Events[]> {
    return await this.eventsModel.find().exec();
  }

  async filter(
    params: FilterEventDto,
  ): Promise<{ count: number; events: EventsDocument[] }> {
    const query = this.eventsModel.find();

    if(params._id) {
      query.where('_id').equals(params._id)
    }

    if (params.name) {
      const regex = new RegExp(params.name, 'i'); // 'i' for case-insensitive
      query.where('name').regex(regex);
    }

    if (params.theme) {
      query.where('theme').equals(params.theme);
    }

    if (params.type) {
      query.where('type').equals(params.type);
    }

    // Add sorting
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

    const [events, count] = await Promise.all([
      query.exec(),
      this.eventsModel.countDocuments(query.getQuery()),
    ]);

    const eventsWithUsers = await Promise.all(
      events.map(async (event) => {
        const users = await this.eventMembersModel.find({ event: event._id, requestStatus: EventRequestStatus.ACCEPTED }).populate('user', 'displayname avatar');
        return Object.assign(event.toObject(), { users: users.map(user => user.user) });
      })
    );

    return { events: eventsWithUsers, count };
  }

  async findOne(id: string): Promise<Events> {
    return await this.eventsModel.findById(id).exec();
  }

  async findById(_id: string): Promise<Events> {
    return await this.eventsModel.findById(_id);
  }

  async update(
    _id: string,
    payload: UpdateEventDto,
  ): Promise<EventsDocument | null> {
    const updateFields = {};
    Object.keys(payload).forEach((key) => {
      if (payload[key] !== undefined) {
        updateFields[key] = payload[key];
      }
    });

    const updatedUser = await this.eventsModel
      .findOneAndUpdate({ _id }, { $set: updateFields }, { new: true })
      .exec();

    return updatedUser;
  }

  async remove(_id: string) {
    return preserveMutation(this.eventsModel.db, [`Events:${_id}`], async () => await this.eventsModel.deleteOne({ _id }));
  }

  async addCover(_id: string, cover: UploadEventCoverDto) {
    return await this.eventsModel.findOneAndUpdate(
      { _id },
      { $set: { cover } },
      { new: true },
    );
  }

  async findExpiredURLEvents(limit: number) {
    // Calculate the date 5 days ago
    const fiveDaysAgo = new Date();
    fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);

    // Find events that have not been updated in the last 5 days and have a cover
    return await this.eventsModel
      .find({
        updatedAt: { $lt: fiveDaysAgo },
        cover: { $exists: true, $ne: null }, // Check if cover exists and is not null
      })
      .limit(limit);
  }
}
