import { ArrayMaxSize, IsArray, IsMongoId, IsOptional } from 'class-validator';

export class NotificationPageDto {
  @IsOptional() @IsMongoId() before?: string;
}
export class ReadNotificationsDto {
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsMongoId({ each: true }) ids?: string[];
}
