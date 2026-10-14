import { ApiProperty } from "@nestjs/swagger";
import { IsEnum, IsOptional } from "class-validator";
import { EventRequestStatus } from "src/common/schemas/event-members.schema";

export class UpdateEventMemberDto {
    @ApiProperty({ enum: EventRequestStatus, default: EventRequestStatus.PENDING })
    @IsEnum(EventRequestStatus)
    @IsOptional()
    requestStatus: EventRequestStatus = EventRequestStatus.ACCEPTED;
}
