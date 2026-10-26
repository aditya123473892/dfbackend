import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  Max,
  Min,
  IsString,
  IsUUID,
  Matches,
} from 'class-validator';

/** Photos per post (carousel). Other resources keep the 5-photo limit. */
export const POST_MAX_IMAGES = 10;
export const MAX_IMAGES_PER_RESOURCE = 5;

export class UploadUrlDto {
  @IsIn(['image/jpeg', 'image/webp']) contentType: 'image/jpeg' | 'image/webp';
  @IsString() @Matches(/^[A-Za-z0-9_-]{8,64}$/) requestId: string;
}
export class VideoUploadUrlDto {
  @IsIn(['video/mp4', 'video/quicktime']) contentType: 'video/mp4' | 'video/quicktime';
  @IsString() @Matches(/^[A-Za-z0-9_-]{8,64}$/) requestId: string;
  @IsInt() @Min(1) @Max(200 * 1024 * 1024) size: number;
}
export class ConfirmVideoDto {
  @IsUUID('4') uploadId: string;
}
export class ConfirmPhotoDto {
  @IsUUID('4') uploadId: string;
}
export class PhotoReferenceDto {
  @IsUUID('4') uploadId: string;
}
export class PhotoListDto {
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(5)
  @IsUUID('4', { each: true })
  photoIds?: string[];
  @IsOptional() @IsString() clientId?: string;
}
