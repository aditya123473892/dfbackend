import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsOptional, IsDate, IsString, IsEnum, IsArray, IsNumber, ValidateNested } from 'class-validator';
import { MediaDto } from 'src/common/dtos/utils.dto/media.dto';
import { EventType } from 'src/common/schemas/events.schema';

export class UpdateEventDto {
  @ApiProperty()
  @IsOptional()
  @IsString()
  name: string;

  @ApiProperty()
  @IsOptional()
  @IsString()
  description: string;

  @ApiProperty()
  @IsOptional()
  @IsString()
  theme: string;

  @ApiProperty()
  @IsOptional()
  startAt: Date;

  @ApiProperty()
  @IsOptional()
  endAt: Date;

  @ApiProperty({ enum: EventType })
  @IsOptional()
  @IsEnum(EventType)
  type: EventType;

  @ApiProperty()
  @IsOptional()
  @IsString()
  location: string;

  @ApiProperty()
  @IsOptional()
  capacity: number;

  @ApiProperty()
  @IsOptional()
  registrationDeadline: Date;

  @ApiProperty({ type: MediaDto, default: {} })
  @IsOptional()
  @ValidateNested({ each: false })
  @Type(() => MediaDto)
  cover: MediaDto;
}
