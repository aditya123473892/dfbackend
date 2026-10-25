import {
  IsBoolean,
  IsIn,
  IsInt,
  IsDateString,
  IsArray,
  ArrayMaxSize,
  ArrayUnique,
  IsUUID,
  Matches,
  IsMongoId,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateChatMessageDto {
  @IsOptional()
  @IsBoolean()
  viewOnce?: boolean;

  @IsOptional()
  @IsInt()
  @IsIn([3, 10, 30, 60])
  viewDurationSeconds?: number;

  @IsOptional()
  @IsInt()
  @IsIn([30, 300, 3600, 86400, 604800])
  ttlSeconds?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  photoIds?: string[];

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{8,64}$/)
  clientId?: string;

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
