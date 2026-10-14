import {
  IsString,
  IsNotEmpty,
  IsEnum,
  IsNumber,
  IsBoolean,
  IsDate,
} from 'class-validator';
import { Types } from 'mongoose';
import { Transform } from 'class-transformer';

export class CreateCouponDto {
  @IsString()
  @IsNotEmpty()
  code: string;

  @IsNotEmpty()
  subscription: Types.ObjectId;
  
  @IsEnum(['percentage', 'fixed'])
  discountType: 'percentage' | 'fixed';

  @IsNumber()
  discountValue: number;

  @IsBoolean()
  isActive: boolean;

  @Transform(({ value }) => new Date(value))  // Convert to Date
  @IsDate()
  expiryDate: Date;
}
