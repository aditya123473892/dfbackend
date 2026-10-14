import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Coupon, CouponDocument } from '../common/schemas/coupon.schema';
import { CreateCouponDto } from './dto/create-coupon.dto';
import { ApplyCouponDto } from './dto/apply-coupon.dto';
import { Types } from 'mongoose';
import {
  Subscription,
  SubscriptionDocument,
} from '../common/schemas/subscription.schema';

@Injectable()
export class CouponService {
  constructor(
    @InjectModel(Coupon.name)
    private readonly couponModel: Model<CouponDocument>,
    @InjectModel(Subscription.name)
    private readonly subscriptionModel: Model<SubscriptionDocument>,
  ) {}

  async create(createCouponDto: CreateCouponDto): Promise<any> {

    const coupon = await this.couponModel.findOne({ subscription: createCouponDto.subscription });
    if (coupon) {
      throw new BadRequestException('Coupon already exists for this subscription');
    }

    const subscription = await this.subscriptionModel.findById(createCouponDto.subscription);
    if (!subscription) {
      throw new NotFoundException('Subscription not found');
    }


    if (createCouponDto.discountType === "fixed") {
      if (createCouponDto.discountValue > subscription.price) {
        throw new BadRequestException("The discount value must be less than the subscription price.");
      }

    } else if (createCouponDto.discountType === "percentage") {
      if (
        createCouponDto.discountValue <= 0 ||
        createCouponDto.discountValue > 100
      ) {
        throw new BadRequestException("Percentage discount must be between 1 and 100");
      }

    } else {
      throw new BadRequestException("Invalid discount type");
    }

    const newCoupon = new this.couponModel(createCouponDto);
    const savedCoupon = await newCoupon.save();
    return savedCoupon.toObject();  // Convert the Mongoose document to a plain object
  }
  

  async findAll(): Promise<Coupon[]> {
    // Cast subscription field to ObjectId if necessary
    return await this.couponModel.find().populate('subscription').exec();
  }

  async findOne(id: string): Promise<Coupon> {
    const coupon = await this.couponModel
      .findById(id)
      .populate('subscription')
      .exec();
    if (!coupon) throw new NotFoundException(`Coupon with ID ${id} not found`);
    return coupon;
  }

  async applyCoupon(applyCouponDto: ApplyCouponDto) {
    const { code, subscriptionId } = applyCouponDto;

    const coupon = await this.couponModel
      .findOne({ code, isActive: true })
      .populate('subscription')
      .exec();
    if (!coupon) throw new NotFoundException('Invalid or expired coupon code');

    if (coupon.subscription._id.toString() !== subscriptionId) {
      throw new BadRequestException(
        'Coupon is not applicable for this subscription',
      );
    }

    if (new Date(coupon.expiryDate) < new Date()) {
      throw new BadRequestException('Coupon has expired');
    }

    const subscprition = await this.subscriptionModel.findById(subscriptionId);
    if(!subscprition){
      throw new NotFoundException('Subscription not found');
    }

    const subscriptionPrice = subscprition.price;
    let finalPrice = subscriptionPrice;

    if (coupon.discountType === 'fixed') {
      finalPrice = Math.max(subscriptionPrice - coupon.discountValue, 0);
    } else if (coupon.discountType === 'percentage') {
      finalPrice = Math.max(subscriptionPrice - (subscriptionPrice * coupon.discountValue) / 100, 0);
    }

    return {
      discountType: coupon.discountType,
      discountValue: coupon.discountValue,
      subscprition,
      finalPrice,
    };
  }

  async findBySubscriptionId(subscriptionId: string): Promise<Coupon[]> {
    console.log(subscriptionId, subscriptionId);
    const objectId = new Types.ObjectId(subscriptionId);
  
    const coupons = await this.couponModel
      .find({ subscription: objectId })
      .exec();
  
    console.log(coupons, 'coupons');
    if (!coupons || coupons.length === 0) {
      throw new NotFoundException(
        `No coupons found for subscription ID ${subscriptionId}`,
      );
    }
    return coupons;
  }
}
