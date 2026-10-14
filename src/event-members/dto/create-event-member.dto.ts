import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsEnum } from 'class-validator';
import { EventRequestStatus } from 'src/common/schemas/event-members.schema';

export class CreateEventMemberRequestDto {
  @ApiProperty()
  @IsNotEmpty()
  event: string;

  @ApiProperty()
  @IsNotEmpty()
  user: string;

  @ApiProperty({ enum: EventRequestStatus, default: EventRequestStatus.PENDING })
  @IsEnum(EventRequestStatus)
  @IsOptional()
  requestStatus: EventRequestStatus = EventRequestStatus.PENDING;

  @ApiProperty()
  @IsOptional()
  @IsString()
  remark?: string;
}
