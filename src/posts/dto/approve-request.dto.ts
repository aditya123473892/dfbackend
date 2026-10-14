import { IsString, IsIn } from 'class-validator';

export class ApprovePostRequestDto {
  @IsString()
  @IsIn(['accepted', 'rejected']) // Ensure only valid values
  status: string;
}