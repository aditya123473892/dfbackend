import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty } from 'class-validator';

export class MediaDto {
  @ApiProperty()
  @IsNotEmpty()
  mimetype: string;

  @ApiProperty()
  @IsNotEmpty()
  url: string;

  @ApiProperty()
  @IsNotEmpty()
  originalname: string;

  @ApiProperty()
  @IsNotEmpty()
  filename: string;
}
