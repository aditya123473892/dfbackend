import { Controller, Get, Post, Body, Param, Delete, Query, Put, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiQuery, ApiBearerAuth, ApiBody } from '@nestjs/swagger';
import { SubscriptionService } from './subscription.service';
import { CreateSubscriptionDto } from './dto/create-subscription.dto';
import { UpdateSubscriptionDto } from './dto/update-subscription.dto';
import { FilterSubscriptionDto } from './dto/filter-subscription.dto';
import { Subscription } from '../common/schemas/subscription.schema';
import { JwtAuthGuard, RolesGuard } from 'src/common/guards';
import { Roles } from 'src/common/decorators';
import { ERole } from 'src/common/enums';
import {badRequestRes, successRes } from 'src/common/interceptors';
import { successGetRes } from 'src/common/interceptors/response.handlers';
import { UsersService } from 'src/users/users.service';
import { MailService } from 'src/mail/mail.service';

@ApiTags('Subscriptions')
@Controller('subscriptions')
export class SubscriptionController {
  constructor(
    private readonly subscriptionService: SubscriptionService,
    private readonly userService: UsersService,
    private readonly mailService: MailService,
  ) {}

  @Roles(ERole.ADMIN)
@ApiBearerAuth()

@UseGuards(JwtAuthGuard, RolesGuard)
  @Post()
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        planName: { type: 'string', description: 'Name of the subscription' },
        description: { type: 'string', description: 'Description of the subscription' },
        price: { type: 'string', description: 'Price of the subscription'},
        duration: { type: 'string', description: 'Duration of subscription' },
        isActive: { type: 'string', description: 'Subscription is active or inactive' },
      },
    },
  })
  @ApiOperation({ summary: 'Create a new subscription' })
  @ApiResponse({ status: 201, description: 'The subscription has been created.', type: Subscription })
  @ApiResponse({ status: 400, description: 'Bad Request' })
  async create(@Body() createSubscriptionDto: CreateSubscriptionDto) {
    // Step 1: Create the subscription
    const subscription = await this.subscriptionService.create(createSubscriptionDto);

    const allUsers = await this.userService.findUsers();
    if (!allUsers || allUsers.length === 0) return badRequestRes('No users found to notify');
    const usersToNotify = allUsers.filter(user => user.roles.includes(ERole.USER));
    if (usersToNotify.length === 0) return badRequestRes('No users with the USER role found to notify');
    const url = `${process.env.PUBLIC_SITE_DOMAIN}/subscprition`;
    for (const user of usersToNotify) {
      const email = user.username; 
      await this.mailService.sendCreateSubscriptionMailForAllUser(email, user.firstName, url , subscription.planName, subscription.description, subscription.price);
    }
    return successRes(subscription);
  }

  @Get()
  @ApiOperation({ summary: 'Get all subscriptions with optional filters' })
  @ApiQuery({ name: 'planName', required: false, type: String, description: 'Filter by plan name' })
  @ApiQuery({ name: 'isActive', required: false, type: Boolean, description: 'Filter by active status' })
  @ApiQuery({ name: 'price', required: false, type: Number, description: 'Filter by price' })
  @ApiQuery({ name: 'duration', required: false, type: Number, description: 'Filter by subscription duration' })
  @ApiResponse({ status: 200, description: 'The list of subscriptions.', type: [Subscription] })
  @ApiResponse({ status: 400, description: 'Bad Request' })
  async findAll(@Query() filterSubscriptionDto: FilterSubscriptionDto) {
    const allSubscription = await this.subscriptionService.findAll(filterSubscriptionDto);
    return successGetRes(allSubscription);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single subscription by ID' })
  @ApiParam({ name: 'id', type: String, description: 'The subscription ID' })
  @ApiResponse({ status: 200, description: 'The subscription details', type: Subscription })
  @ApiResponse({ status: 404, description: 'Subscription not found' })
  async findOne(@Param('id') id: string) {
    const subscription = await this.subscriptionService.findOne(id);

    return successGetRes(subscription);
  }

  @Roles(ERole.ADMIN)
@ApiBearerAuth()

@UseGuards(JwtAuthGuard, RolesGuard)
  @Put(':id')
  @ApiOperation({ summary: 'Update an existing subscription' })
  @ApiParam({ name: 'id', type: String, description: 'The subscription ID' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        planName: { type: 'string', description: 'Name of the subscription' },
        description: { type: 'string', description: 'Description of the subscription' },
        price: { type: 'string', description: 'Price of the subscription'},
        duration: { type: 'string', description: 'Duration of subscription' },
        isActive: { type: 'string', description: 'Subscription is active or inactive' },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'The subscription has been updated.', type: Subscription })
  @ApiResponse({ status: 404, description: 'Subscription not found' })
  async update(
    @Param('id') id: string,
    @Body() updateSubscriptionDto: UpdateSubscriptionDto,
  ) {
    const updateSubscription = await this.subscriptionService.update(id, updateSubscriptionDto);
  
    return successRes(updateSubscription);
  }

  @Roles(ERole.ADMIN)
@ApiBearerAuth()

@UseGuards(JwtAuthGuard, RolesGuard)
  @Delete(':id')
  @ApiOperation({ summary: 'Delete a subscription by ID' })
  @ApiParam({ name: 'id', type: String, description: 'The subscription ID' })
  @ApiResponse({ status: 200, description: 'The subscription has been deleted.' })
  @ApiResponse({ status: 404, description: 'Subscription not found' })
  async remove(@Param('id') id: string) {
    const subscription = await this.subscriptionService.remove(id);

    return successGetRes({ deleted: true }, 'Post deleted!');
  }
}
