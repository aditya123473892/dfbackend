import { IsMongoId, IsNotEmpty } from 'class-validator';

export class CreateLikeDto {
  @IsMongoId()
  @IsNotEmpty()
  post: string;
}
