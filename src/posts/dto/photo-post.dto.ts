import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { PartialType, OmitType } from '@nestjs/mapped-types';
import { EContentVisibility, EPostVisibility } from '../../common/enums/posts.enum';
import { POST_MAX_IMAGES } from '../../photos/photo.dto';
export class PhotoPostDto {
  @IsOptional() @IsEnum(EContentVisibility) contentVisibility?: EContentVisibility;
  @IsString() @Matches(/^[A-Za-z0-9_-]{8,64}$/) clientId: string;
  @IsOptional() @IsString() @MaxLength(500) caption?: string;
  @IsOptional() @IsString() @MaxLength(200) location?: string;
  @IsOptional() @IsEnum(EPostVisibility) visibility?: EPostVisibility;
  /** At least one photo or video is required; checked by the controller. */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(POST_MAX_IMAGES)
  @IsUUID('4', { each: true })
  photoIds?: string[];
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(1)
  @IsUUID('4', { each: true })
  videoIds?: string[];
}
export class EditPhotoPostDto extends PartialType(
  OmitType(PhotoPostDto, ['clientId'] as const),
) {}
