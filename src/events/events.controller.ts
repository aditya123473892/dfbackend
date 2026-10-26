import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UploadedFile,
  UseInterceptors,
  UseGuards,
  Query,
  Put,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { badRequestRes, successRes } from 'src/common/interceptors';
import { PhotosService } from '../photos/photos.service';
import { NotFoundException, ValidationPipe } from '@nestjs/common';
import { Types } from 'mongoose';
import { EventsService } from './events.service';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { AuthUser, Roles } from 'src/common/decorators';
import { DefaultFindParams, IAuthUser } from 'src/common/interfaces';
import { FilterEventDto } from './dto/filter-event.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { S3BucketService } from 'src/s3-bucket/s3-bucket.service';
import { S3Folder } from 'src/common/enums/utils.enum';
import { UploadEventCoverDto } from './dto/upload-event-cover.dto';
import { JwtAuthGuard, RolesGuard } from 'src/common/guards';
import { ERole } from 'src/common/enums';
import { UsersService } from '../users/users.service';
import { MailService } from 'src/mail/mail.service';

@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@ApiTags('Events')
@Controller('events')
export class EventsController {
  constructor(
    private readonly eventsService: EventsService,
    private readonly photos: PhotosService,
    private readonly userService: UsersService,
    private readonly mailService: MailService,
    private readonly s3BucketService: S3BucketService,
  ) {}

  @Roles(ERole.ADMIN)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Post()
  @ApiOperation({ summary: 'Create a new event with a cover image' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the event' },
        description: {
          type: 'string',
          description: 'Description of the event',
        },
        theme: { type: 'string', description: 'Theme of the event' },
        startAt: {
          type: 'string',
          format: 'date-time',
          description: 'Event start time',
        },
        endAt: {
          type: 'string',
          format: 'date-time',
          description: 'Event end time',
        },
        type: {
          type: 'string',
          enum: ['online', 'offline'],
          description: 'Event type',
        },
        location: { type: 'string', description: 'Event location' },
        capacity: { type: 'number', description: 'Event capacity' },
        registrationDeadline: {
          type: 'string',
          format: 'date-time',
          description: 'Event registration deadline',
        },
        cover: {
          type: 'string',
          format: 'binary',
          description: 'Cover image of the event',
        },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Event created successfully' })
  @ApiResponse({
    status: 400,
    description: 'Bad request, event creation failed',
  })
  async create(
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    dto: CreateEventDto,
    @AuthUser() actor: IAuthUser,
  ) {
    const id = new Types.ObjectId().toString();
    const payload: any = { _id: id, creator: actor.id };
    for (const key of [
      'name',
      'description',
      'theme',
      'startAt',
      'endAt',
      'type',
      'location',
      'capacity',
      'registrationDeadline',
    ]) {
      if (dto[key] !== undefined) payload[key] = dto[key];
    }
    if (dto.coverUploadId)
      [payload.cover] = await this.photos.bind(
        actor.id,
        [dto.coverUploadId],
        `event:${id}`,
      );
    return successRes(await this.eventsService.create(payload));
  }

  @Get()
  async findAll(@Query() params: FilterEventDto) {
    const options: FilterEventDto = {
      ...DefaultFindParams,
      ...params,
    };

    const { events, count } = await this.eventsService.filter(options);

    return successRes({ events, count });
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    const event = await this.eventsService.findOne(id);
    if (!event) return badRequestRes('Event not found!');
    return successRes(event);
  }

  @Roles(ERole.ADMIN)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Put(':id')
  @ApiOperation({ summary: 'Update an existing event' })
  @ApiConsumes('multipart/form-data')
  @ApiParam({
    name: 'id',
    description: 'ID of the event',
    type: String,
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        theme: { type: 'string' },
        startAt: { type: 'string', format: 'date-time' },
        endAt: { type: 'string', format: 'date-time' },
        type: { type: 'string', enum: ['online', 'offline'] },
        location: { type: 'string' },
        capacity: { type: 'number' },
        registrationDeadline: { type: 'string', format: 'date-time' },
        status: { type: 'string', enum: ['active', 'canceled', 'completed'] },
        cover: {
          type: 'string',
          format: 'binary',
          description: 'Cover image for the event (optional)',
        },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Event updated successfully' })
  @ApiResponse({ status: 400, description: 'Bad request, event update failed' })
  async update(
    @Param('id') id: string,
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    dto: UpdateEventDto,
    @AuthUser() actor: IAuthUser,
  ) {
    const current = await this.eventsService.findById(id);
    if (!current) throw new NotFoundException('Event not found');
    const payload: any = {};
    for (const key of [
      'name',
      'description',
      'theme',
      'startAt',
      'endAt',
      'type',
      'location',
      'capacity',
      'registrationDeadline',
    ]) {
      if (dto[key] !== undefined) payload[key] = dto[key];
    }
    if (dto.coverUploadId)
      [payload.cover] = await this.photos.bind(
        actor.id,
        [dto.coverUploadId],
        `event:${id}`,
      );
    const event = await this.eventsService.update(id, payload);
    if (!event) throw new NotFoundException('Event not found');
    if (payload.cover) {
      await this.photos.retire(`event:${id}`, [current.cover?.filename]);
      await this.photos.enqueue([
        current.cover?.filename || current.cover?.url,
      ]);
    }
    return successRes(event);
  }

  @Roles(ERole.ADMIN)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Delete(':id')
  @ApiOperation({
    summary: 'Delete an event and remove associated cover image from AWS',
  })
  @ApiResponse({ status: 200, description: 'Event deleted successfully' })
  @ApiResponse({
    status: 400,
    description: 'Bad request, event deletion failed',
  })
  async remove(@Param('id') id: string) {
    const foundEvent = await this.eventsService.findById(id);
    if (!foundEvent) return badRequestRes('Event not found!');

    await this.photos.enqueue([
      foundEvent.cover?.filename || foundEvent.cover?.url,
    ]);
    const deleteEvent = await this.eventsService.remove(id);
    if (!deleteEvent.deletedCount)
      return badRequestRes('Failed to delete event!');

    return successRes({ deleted: true }, 'Event deleted successfully!');
  }
}
