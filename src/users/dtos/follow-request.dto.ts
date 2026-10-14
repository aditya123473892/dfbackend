import { IsNotEmpty, IsMongoId, IsBoolean } from 'class-validator';

export class FollowRequestDto {
  @IsNotEmpty()
  @IsMongoId()
  following: string;
}
