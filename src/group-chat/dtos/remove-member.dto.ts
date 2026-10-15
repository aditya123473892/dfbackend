import { ArrayMaxSize, ArrayMinSize, IsArray, IsMongoId, IsNotEmpty } from 'class-validator';

export class RemoveMembersDto {
  @IsMongoId()
  @IsNotEmpty()
  groupId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(255)
  @IsMongoId({ each: true })
  members: string[];
}
