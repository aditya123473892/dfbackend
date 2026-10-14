import { ApiProperty } from '@nestjs/swagger';
import { IsOptional } from 'class-validator';
import { FindQueryDto } from '../../common/dtos/utils.dto';
import { EPostStatus, EPostVisibility } from 'src/common/enums/posts.enum';

export class FilterPostDto extends FindQueryDto {
  @ApiProperty({ required: false })
  @IsOptional()
  user?: string;

  @ApiProperty({
    required: false,
    enum: EPostVisibility,
    default: EPostVisibility.PUBLIC,
  })
  @IsOptional()
  visibility?: EPostVisibility;

  @ApiProperty({
    required: false,
    enum: EPostStatus,
    default: EPostStatus.APPROVED,
  })
  @IsOptional()
  status?: EPostStatus;

  @ApiProperty({ required: false })
  @IsOptional()
  updatedAt?: string | Date;
}
