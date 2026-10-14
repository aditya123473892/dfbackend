import { IsBoolean } from 'class-validator';

export class ApproveUserRequestDto {
  @IsBoolean()
  status: boolean;
}
