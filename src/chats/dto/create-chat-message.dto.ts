import {
  IsDateString,
  IsMongoId,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateChatMessageDto {
  @IsOptional()
  @IsMongoId()
  receiver?: string;

  @IsOptional()
  @IsMongoId()
  groupId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10000)
  message?: string;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}

export class ChatMediaQueryDto {
  @IsOptional()
  @IsMongoId()
  receiver?: string;

  @IsOptional()
  @IsMongoId()
  groupId?: string;
}

export class UpdateChatMediaExpiryDto {
  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}
