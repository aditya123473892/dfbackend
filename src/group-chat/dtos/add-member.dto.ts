import { IsNotEmpty, IsArray, IsMongoId } from 'class-validator';

export class AddMembersDto {
  @IsMongoId()
  @IsNotEmpty()
  groupId: string;

  @IsArray()
  @IsMongoId({ each: true })
  members: string[];
}
