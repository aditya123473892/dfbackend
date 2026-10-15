import { ApiHideProperty, ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { MediaDto } from 'src/common/dtos/utils.dto/media.dto';
import { EPostStatus, EPostVisibility } from 'src/common/enums/posts.enum';

export const MAX_CAPTION_LENGTH = 2200;

export class CreatePostDto {
  @ApiProperty()
  @IsOptional()
  @IsString()
  @MaxLength(MAX_CAPTION_LENGTH)
  caption: string;

  @ApiProperty()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  location: string;

  @ApiProperty({ enum: EPostVisibility, default: EPostVisibility.PRIVATE })
  @IsOptional()
  @IsEnum(EPostVisibility)
  visibility: EPostVisibility;

  // Set by moderation only. The user routes discard any client-sent value.
  @ApiHideProperty()
  @IsOptional()
  @IsEnum(EPostStatus)
  status: EPostStatus;

  @ApiHideProperty()
  @IsOptional()
  user: string;

  @ApiProperty({ type: [MediaDto], default: [] }) // Define the type for Swagger UI
  @IsOptional()
  @ValidateNested({ each: false }) // Validate each item in the array
  @Type(() => MediaDto)
  media: MediaDto[];
}
