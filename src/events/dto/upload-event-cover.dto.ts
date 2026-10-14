import { ApiHideProperty } from '@nestjs/swagger';
import { IsOptional } from 'class-validator';

export class UploadEventCoverDto {
  @ApiHideProperty()
  @IsOptional()
  mimetype: string;

  @ApiHideProperty()
  @IsOptional()
  url: string;

  @ApiHideProperty()
  @IsOptional()
  originalname: string;

  @ApiHideProperty()
  @IsOptional()
  filename: string;
}
