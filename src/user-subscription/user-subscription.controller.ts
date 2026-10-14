import { Controller, Get, Post, Body, Param, Delete, Query, Put, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiQuery, ApiBearerAuth, ApiBody } from '@nestjs/swagger';
import { UserSubscriptionService } from './user-subscription.service';
import { CreateUserSubscriptionDto } from './dto/user-create-subscription.dto';
import { JwtAuthGuard, RolesGuard } from 'src/common/guards';
import { Roles } from 'src/common/decorators';
import { ERole } from 'src/common/enums';
import {badRequestRes, successRes } from 'src/common/interceptors';
import { successGetRes } from 'src/common/interceptors/response.handlers';
import { UsersService } from 'src/users/users.service';
import { MailService } from 'src/mail/mail.service';

@ApiTags('User Subscriptions')
@Controller('user-subscriptions')
export class UserSubscriptionController {
  constructor(
    private readonly userSubscriptionService: UserSubscriptionService,
    private readonly userService: UsersService,
    // private readonly mailService: MailService,
  ) {}

  @Post()
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        user: { 
          type: 'string', 
          description: 'The user ID (must be a valid MongoDB ObjectId)' 
        },
        subscription: { 
          type: 'string', 
          description: 'The subscription ID (must be a valid MongoDB ObjectId)' 
        },
        coupon: { 
          type: 'string', 
          description: 'The coupon ID (optional, must be a valid MongoDB ObjectId)', 
          nullable: true 
        },
        // email: { 
        //   type: 'string', 
        //   description: 'Enter you email', 
        //   nullable: true 
        // },
        // country: { 
        //   type: 'string', 
        //   description: 'Enter you Country', 
        //   nullable: true 
        // },
        fullame: { 
          type: 'string', 
          description: 'Enter you fullName', 
          nullable: true 
        },
      },
      required: ['user', 'subscription'],
    },
  })
  async create(@Body() createUserSubscriptionDto: CreateUserSubscriptionDto) {
    const { user, subscription, coupon } = createUserSubscriptionDto;
  
    const existingRecord = await this.userSubscriptionService.findByUserSubscriptionAndCoupon(user, subscription, coupon);
  
    if (existingRecord) {
      return badRequestRes('A record with the same user, subscription, and coupon already exists');
    }
    const subscriptionRecord = await this.userSubscriptionService.create(createUserSubscriptionDto);
    return successRes(subscriptionRecord);
  }
  

  @Get()
  @ApiOperation({ summary: 'Get all user subscriptions with optional filters' })
  @ApiQuery({ name: 'userId', required: true, type: String, description: 'Filter by user ID' })
  @ApiResponse({ status: 200, description: 'The list of subscriptions.', })
  @ApiResponse({ status: 400, description: 'Bad Request' })
  async findAll(
    @Query('userId') userId: string,
  ) {
    if (!userId) {
      throw new Error('User ID is required.');
    }
  
    const allSubscription = await this.userSubscriptionService.findAll(userId);
    return successGetRes(allSubscription);
  }
  
  @Get(':userId')
  @ApiOperation({ summary: 'Get a single user subscription by user ID' })
  @ApiResponse({ status: 200, description: 'The user subscription details', })
  @ApiResponse({ status: 404, description: ' user Subscription not found' })
  async findOne(@Param('userId') userId: string) {
    const subscription = await this.userSubscriptionService.findOne(userId);
    return successGetRes(subscription);
  }
  
}