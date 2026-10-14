import { IsString, IsNumber, IsBoolean, IsNotEmpty, IsOptional } from 'class-validator';

export class UpdateSubscriptionDto {
    @IsString()
    @IsOptional()
    planName: string;

    @IsString()
    @IsOptional()
    description: string;

    @IsNumber()
    @IsOptional()
    price: number;

    @IsNumber()
    @IsOptional()
    duration: number;

    @IsBoolean()
    @IsOptional()
    isActive: boolean;
}
