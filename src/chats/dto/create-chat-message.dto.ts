import {
  IsDateString,
  IsMongoId,
  IsOptional,
  IsString,
  Matches,
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

  // Idempotency key generated once per message by the client and reused on
  // retries.
  @IsOptional()
  @Matches(/^[A-Za-z0-9_-]{8,64}$/)
  clientId?: string;

  // Disappearing-message timer. Multipart bodies carry strings, so both forms
  // are accepted here; ChatService validates against MESSAGE_TTL_SECONDS.
  @IsOptional()
  ttlSeconds?: number | string;

  // View-once media: `true` or "true" (multipart). Validated by ChatService.
  @IsOptional()
  viewOnce?: boolean | string;
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
