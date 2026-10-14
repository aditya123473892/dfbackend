import { ApiHideProperty, ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsOptional, ValidateNested } from 'class-validator';
import { MediaDto } from 'src/common/dtos/utils.dto/media.dto';
import { EPostStatus, EPostVisibility } from 'src/common/enums/posts.enum';

export class CreatePostDto {
  @ApiProperty()
  @IsOptional()
  caption: string;

  @ApiProperty()
  @IsOptional()
  location: string;

  @ApiProperty({ enum: EPostVisibility, default: EPostVisibility.PRIVATE })
  @IsOptional()
  visibility: EPostVisibility;

  @ApiProperty({ enum: EPostStatus, default: EPostStatus.PENDING })
  @IsOptional()
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
