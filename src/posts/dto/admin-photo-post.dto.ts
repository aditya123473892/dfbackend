import { IsEnum, IsMongoId, IsOptional } from 'class-validator';
import { EditPhotoPostDto } from './photo-post.dto';
import { EPostStatus } from '../../common/enums/posts.enum';

export class AdminPhotoPostDto extends EditPhotoPostDto {
  @IsOptional() @IsEnum(EPostStatus) status?: EPostStatus;
}
export class AdminCreatePhotoPostDto extends AdminPhotoPostDto {
  @IsMongoId() user: string;
}
