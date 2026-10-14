import { IsOptional, IsString, IsArray, IsNotEmpty } from 'class-validator';


export class LocationDto {
  @IsNotEmpty()
  city: string;

  @IsNotEmpty()
  state: string;
  
  @IsNotEmpty()
  country: string;
}
export class UpdateUserProfileDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  displayname?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  firstName?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  lastName?: string;

  @IsOptional()
  @IsString()
  avatar?: string;

  @IsOptional()
  // @IsArray()
  @IsString({ each: true })
  intrests?: string[];

  @IsOptional()
  @IsString()
  bio?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  state?: string;

  @IsOptional()
  @IsString()
  country?: string;

}
