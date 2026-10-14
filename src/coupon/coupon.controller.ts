import { Controller, Get, Post, Body, Param, HttpCode, HttpStatus, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody, ApiParam, ApiBearerAuth } from '@nestjs/swagger';
import { CouponService } from './coupon.service';
import { CreateCouponDto } from './dto/create-coupon.dto';
import { ApplyCouponDto } from './dto/apply-coupon.dto';
import { Coupon } from '../common/schemas/coupon.schema';
import { Types } from 'mongoose';
import { ERole } from 'src/common/enums';
import { JwtAuthGuard, RolesGuard } from 'src/common/guards';
import { Roles } from 'src/common/decorators';

@ApiTags('Coupons')
@Controller('coupons')
export class CouponController {
  constructor(private readonly couponService: CouponService) {}

  @Roles(ERole.ADMIN)
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Post()
  @ApiOperation({ summary: 'Create a new coupon', description: 'Creates a new coupon associated with a specific subscription.' })
  @ApiResponse({ status: HttpStatus.CREATED, description: 'Coupon created successfully', type: Coupon })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Invalid request data' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Coupon code' },
        discountType: { type: 'string', description: 'Discount type' },
        subscription: { type: 'string', description: 'Subscription Id' },
        discountValue: { type: 'string', description: 'Amount of the discount'},
        isActive: { type: 'string', description: 'Coupon is active or inactive' },
        expiryDate: { type: 'string', description: 'Expiry date of coupun' },
      },
    },
  })

async create(@Body() createCouponDto: CreateCouponDto) {
  // Ensure subscription is a valid ObjectId
  if (!Types.ObjectId.isValid(createCouponDto.subscription)) {
    throw new Error('Invalid Subscription ID');
  }

  // Optionally cast to ObjectId
  createCouponDto.subscription = new Types.ObjectId(createCouponDto.subscription);

  const newCoupon = await this.couponService.create(createCouponDto);
  return {
    _doc: newCoupon,
    $isNew: newCoupon.isNew,  // Manually access the `isNew` property
    statusCode: 201,
  };
}


  @Get()
  @ApiOperation({ summary: 'Get all coupons', description: 'Fetches all available coupons from the system.' })
  @ApiResponse({ status: HttpStatus.OK, description: 'List of all coupons', type: [Coupon] })
  async findAll() {
    try {
      return await this.couponService.findAll();
    } catch (err) {
      console.error(err);  // Log the error for debugging purposes
      throw new Error('An error occurred while fetching coupons');
    }
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single coupon by ID', description: 'Fetches details of a specific coupon by its ID.' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Coupon details', type: Coupon })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Coupon not found' })
  @ApiParam({ name: 'id', description: 'Coupon ID', type: String })
  async findOne(@Param('id') id: string) {
    return await this.couponService.findOne(id);
  }


  @Post('/apply')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Apply a coupon code', description: 'Validates and applies a coupon to a specific subscription.' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Coupon applied successfully', schema: { example: { discountType: 'percentage', discountValue: 20 } } })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Coupon not valid for this subscription or expired' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Coupon code not found' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Coupon code' },
        subscriptionId: { type: 'string', description: 'Subscription Id' }
      },
    },
  })
  async applyCoupon(@Body() applyCouponDto: ApplyCouponDto) {
    return await this.couponService.applyCoupon(applyCouponDto);
  }

  @Get('/subscription/:subscriptionId')
  @ApiOperation({ summary: 'Get a coupon by subscriptionId', description: 'Fetches details of a specific coupon by its subscriptionId.' })
  @ApiParam({ name: 'subscriptionId', description: 'Subscription ID', type: String })
  async findBySubscriptionId(@Param('subscriptionId') subscriptionId: string) {
    return await this.couponService.findBySubscriptionId(subscriptionId);
  }
}
