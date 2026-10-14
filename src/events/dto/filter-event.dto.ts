import { ApiProperty } from '@nestjs/swagger';
import { IsOptional } from 'class-validator';
import { FindQueryDto } from '../../common/dtos/utils.dto';
import { EventType } from 'src/common/schemas/events.schema';

export class FilterEventDto extends FindQueryDto {
  @ApiProperty({ required: false })
  @IsOptional()
  name?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  theme?: string;

  @ApiProperty({
    required: false,
    enum: EventType,
  })
  @IsOptional()
  type?: EventType;
}
