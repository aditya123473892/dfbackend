import {
  IsString,
  IsNotEmpty,
  IsMongoId,
  IsOptional,
  Matches,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';

export const MAX_COMMENT_LENGTH = 2000;

export class CreateCommentDto {
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MaxLength(MAX_COMMENT_LENGTH)
  content: string;

  @IsMongoId()
  @IsNotEmpty()
  post: string;

  // Idempotency key generated once per comment and reused on retries.
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{8,64}$/)
  clientId?: string;
}
