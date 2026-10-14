import { IsString } from 'class-validator';

export class CreateUserEditHistoryDto {
  @IsString()
  remark: string;
}
