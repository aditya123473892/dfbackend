import { IsOptional, IsString, IsNumber, IsBoolean } from 'class-validator';

export class FilterSubscriptionDto {
  @IsString()
  @IsOptional()
  planName?: string;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @IsNumber()
  @IsOptional()
  price?: number;

  @IsNumber()
  @IsOptional()
  duration?: number;
}
