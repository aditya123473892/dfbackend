import { IsMongoId, IsOptional } from 'class-validator';

export class CreateUserSubscriptionDto {
  @IsMongoId()
  user: string; 

  @IsMongoId()
  subscription: string;

  @IsMongoId()
  @IsOptional()
  coupon?: string;
  
  // @IsOptional()
  // email?: string;

  // @IsOptional()
  // @IsOptional()
  // country?:string

  @IsOptional()
  fullname?: string;
}
