import { IsNotEmpty, IsString, IsArray, IsMongoId, IsOptional } from 'class-validator';

export class CreateGroupDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsMongoId()
  @IsOptional()
  admin?: string;

  @IsArray()
  @IsMongoId({ each: true })
  members: string[];
}
