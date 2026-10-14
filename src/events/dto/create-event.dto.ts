import { ApiHideProperty, ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsDate, IsString, IsEnum, IsArray, IsNumber, ValidateNested } from 'class-validator';
import { MediaDto } from 'src/common/dtos/utils.dto/media.dto';
import { EventType } from 'src/common/schemas/events.schema';

export class CreateEventDto {

  @ApiHideProperty()
  @IsOptional()
  creator: string;

  @ApiProperty()
  @IsNotEmpty()
  name: string;

  @ApiProperty()
  @IsOptional()
  description: string;

  @ApiProperty()
  @IsOptional()
  theme: string;

  @ApiProperty()
  @IsNotEmpty()
  startAt: Date;

  @ApiProperty()
  @IsNotEmpty()
  endAt: Date;

  @ApiProperty({ enum: EventType, default: EventType.ONLINE })
  @IsNotEmpty()
  @IsEnum(EventType)
  type: EventType;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  location: string;

  @ApiProperty({ required: false })
  @IsOptional()
  capacity: number;

  @ApiProperty({ required: false })
  @IsOptional()
  registrationDeadline: Date;

  @ApiProperty({ type: MediaDto, default: {} })
  @IsOptional()
  @ValidateNested({ each: false })
  @Type(() => MediaDto)
  cover: MediaDto;
}
