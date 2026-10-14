import { IsNotEmpty, IsMongoId, IsBoolean } from 'class-validator';

export class PostRequestDto {
  @IsNotEmpty()
  @IsMongoId()
  userId: string;
}