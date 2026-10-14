import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Subscription, SubscriptionDocument } from '../common/schemas/subscription.schema';
import { CreateSubscriptionDto } from './dto/create-subscription.dto';
import { UpdateSubscriptionDto } from './dto/update-subscription.dto';
import { FilterSubscriptionDto } from './dto/filter-subscription.dto';

@Injectable()
export class SubscriptionService {
  constructor(
    @InjectModel(Subscription.name) private readonly subscriptionModel: Model<SubscriptionDocument>,
  ) {}


  async create(createSubscriptionDto: CreateSubscriptionDto): Promise<Subscription> {
    const newSubscription = new this.subscriptionModel(createSubscriptionDto);
    return await newSubscription.save();
  }


  async findAll(filterSubscriptionDto: FilterSubscriptionDto): Promise<Subscription[]> {
    const { planName, isActive, price, duration } = filterSubscriptionDto;

    const filterConditions: any = {};
    if (planName) filterConditions.planName = new RegExp(planName, 'i');
    if (isActive !== undefined) filterConditions.isActive = isActive;
    if (price) filterConditions.price = price;
    if (duration) filterConditions.duration = duration;

    return await this.subscriptionModel.find(filterConditions).exec();
  }

  async findOne(id: string): Promise<Subscription> {
    const subscription = await this.subscriptionModel.findById(id).exec();
    if (!subscription) {
      throw new NotFoundException(`Subscription with ID ${id} not found`);
    }
    return subscription;
  }

  async update(id: string, updateSubscriptionDto: UpdateSubscriptionDto): Promise<Subscription> {
    const updatedSubscription = await this.subscriptionModel.findByIdAndUpdate(id, updateSubscriptionDto, {
      new: true,
    }).exec();
    
    if (!updatedSubscription) {
      throw new NotFoundException(`Subscription with ID ${id} not found`);
    }
    return updatedSubscription;
  }

  async remove(id: string): Promise<void> {
    return await this.subscriptionModel.findByIdAndDelete(id);
  }
}
