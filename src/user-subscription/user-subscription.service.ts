import { Injectable, NotFoundException } from '@nestjs/common';
import { Model } from 'mongoose';
import { CreateUserSubscriptionDto } from './dto/user-create-subscription.dto';
import { UserSubscription, UserSubscriptionDocument } from '../common/schemas/user-subscription.schema';
import { InjectModel } from '@nestjs/mongoose';

@Injectable()
export class UserSubscriptionService {
  constructor(
    @InjectModel(UserSubscription.name)
    private readonly userSubscriptionModel: Model<UserSubscriptionDocument>,
  ) {}


  async create(createUserSubscriptionDto: CreateUserSubscriptionDto): Promise<UserSubscription> {

    const newSubscription = new this.userSubscriptionModel(createUserSubscriptionDto);
    return await newSubscription.save();
  }

  async findByUserSubscriptionAndCoupon(user: string, subscription: string, coupon?: string): Promise<UserSubscription | null> {
    const filter: any = { user, subscription };
    if (coupon) filter.coupon = coupon;
  
    return await this.userSubscriptionModel.findOne(filter).exec();
  }


  async findAll(userId: string): Promise<UserSubscription[]> {
    const filterConditions: any = { user: userId };
    return await this.userSubscriptionModel
      .find(filterConditions)
      .populate('user', '-password -__v')
      .populate('subscription')
      .populate('coupon')
      .exec();
  }
  
  async findOne(userId: string): Promise<UserSubscription> {
    const subscription = await this.userSubscriptionModel
      .findOne({ user: userId })
      .populate('user', '-password -__v')
      .populate('subscription')
      .populate('coupon')
      .exec();

    // if (!subscription) {
    //   throw new NotFoundException('Subscription not found');
    // }

    return subscription || null;
  }
  
}
