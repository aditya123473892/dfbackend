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
  @UseInterceptors(FileInterceptor('cover'))
  async create(
    @Body() createEventDto: CreateEventDto,
    @UploadedFile() cover: Express.Multer.File,
    @AuthUser() user: IAuthUser,
  ) {
    if (cover) {
      const uploadedFile = await this.s3BucketService.uploadFile(
        cover,
        S3Folder.EVENTS,
      );
      if (!uploadedFile) return badRequestRes('Failed to upload cover image!');

      const url = await this.s3BucketService.getSignedURL(
        uploadedFile.Key,
        process.env.AWS_DEFAULT_S3_BUCKET,
      );
      if (!url)
        return badRequestRes('Failed to generate URL for the cover image');

      createEventDto.cover = {
        originalname: cover.originalname,
        mimetype: cover.mimetype,
        filename: uploadedFile.Key,
        url: url,
      };
    }

    createEventDto.creator = user.id;

    const event = await this.eventsService.create(createEventDto);
    if (!event) return badRequestRes('Failed to create event');

    const url = `${process.env.PUBLIC_SITE_DOMAIN}/events`;
    const allUsers = await this.userService.findUsers();
    if (!allUsers || allUsers.length === 0) return badRequestRes('No users found to notify');
    const usersToNotify = allUsers.filter(user => user.roles.includes(ERole.USER));
  
    if (usersToNotify.length === 0) return badRequestRes('No users with the USER role found to notify');
    for (const user of usersToNotify) {
      const email = user.username;
      await this.mailService.sendCreateEventMailForAllUser(email, user.firstName,url);
    }

    return successRes(event);
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
  @UseInterceptors(FileInterceptor('cover'))
  async update(
    @Param('id') id: string,
    @Body() payload: UpdateEventDto,
    @UploadedFile() cover: Express.Multer.File,
    @AuthUser() user: IAuthUser,
  ) {
    const event = await this.eventsService.findById(id);
    if (!event) return badRequestRes('Event not found!');

    if (cover) {
      if (event.cover && event.cover.filename) {
        await this.s3BucketService.deleteOne(
          event.cover.filename,
          process.env.AWS_DEFAULT_S3_BUCKET,
        );
      }

      const uploadedFile = await this.s3BucketService.uploadFile(
        cover,
        'events',
      );
      if (!uploadedFile) return badRequestRes('Failed to upload cover image!');

      const url = await this.s3BucketService.getSignedURL(
        uploadedFile.Key,
        process.env.AWS_DEFAULT_S3_BUCKET,
      );
      if (!url)
        return badRequestRes('Failed to generate signed URL for cover image');

      payload.cover = {
        originalname: cover.originalname,
        mimetype: cover.mimetype,
        filename: uploadedFile.Key,
        url: url,
      };
    }

    const updatedEvent = await this.eventsService.update(id, payload);
    if (!updatedEvent) return badRequestRes('Failed to update event!');

    return successRes(updatedEvent);
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

    if (foundEvent.cover && foundEvent.cover.filename) {
      try {
        await this.s3BucketService.deleteOne(
          foundEvent.cover.filename,
          process.env.AWS_DEFAULT_S3_BUCKET,
        );
      } catch (error) {
        return badRequestRes('Failed to delete cover image from S3');
      }
    }

    const deleteEvent = await this.eventsService.remove(id);
    if (!deleteEvent.deletedCount)
      return badRequestRes('Failed to delete event!');

    return successRes({ deleted: true }, 'Event deleted successfully!');
  }
}
