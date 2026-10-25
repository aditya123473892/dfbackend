import {
  IsString,
  IsNotEmpty,
  IsMongoId,
  IsOptional,
  Matches,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';

export class CreateCommentDto {
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MaxLength(2000)
  content: string;

  @IsMongoId()
  @IsNotEmpty()
  post: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{8,64}$/)
  clientId?: string;
}
