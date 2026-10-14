import { ApiProperty } from '@nestjs/swagger';
import { IsOptional } from 'class-validator';
import { FindQueryDto } from './find-query.dto';
import { SortOrder } from 'mongoose';

export class FindOneQueryDto {
  @ApiProperty({ required: false })
  @IsOptional()
  sortBy?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  order?: SortOrder;

  @ApiProperty({ required: false })
  @IsOptional()
  _id?: string;
}
