import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty } from 'class-validator';
import { EventRequestStatus } from 'src/common/schemas/event-members.schema';
export class UpdateEventMemberStatusDto {

  @ApiProperty({
    enum: EventRequestStatus,
    default: EventRequestStatus.ACCEPTED,
  })
  @IsNotEmpty()
  requestStatus: EventRequestStatus;

}
