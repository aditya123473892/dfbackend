import { ApiProperty } from '@nestjs/swagger';
import { IsOptional } from 'class-validator';
import { FindQueryDto } from '../../common/dtos/utils.dto';
import { EPostStatus, EPostVisibility } from 'src/common/enums/posts.enum';

export class FindMyPostDto extends FindQueryDto {
  @ApiProperty({ required: false })
  @IsOptional()
  user?: string;

  @ApiProperty({
    required: false,
    enum: EPostVisibility,
    default: null,
  })
  @IsOptional()
  visibility?: EPostVisibility;

  @ApiProperty({
    required: false,
    enum: EPostStatus,
    default: null,
  })
  @IsOptional()
  status?: EPostStatus;
}
